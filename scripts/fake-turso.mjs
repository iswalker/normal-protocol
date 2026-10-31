/* fake-turso.mjs — a stand-in for Turso's HTTP pipeline (POST /v2/pipeline),
   backed by an in-memory SQLite (node:sqlite), so the real functions/api/*.js
   handlers can be tested without touching the live database.

   Mirrors the parts of the protocol the app relies on:
     - "execute": runs one statement; an error is reported for THAT request only
       and the following requests still run (Turso does the same -- which is why
       a BEGIN ... COMMIT sent as plain requests commits whatever succeeded);
     - "batch": steps with conditions (ok / error / not / and / or), each step
       reporting its own result or error;
     - "close".
   Usage:  const t = await startFakeTurso(); t.db.exec('...'); env = { TURSO_URL: t.url, TURSO_TOKEN: 'x' }; */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const toArg = (a) => {
  if (!a || a.type === 'null') return null;
  if (a.type === 'integer') return BigInt(a.value);
  if (a.type === 'float') return Number(a.value);
  return String(a.value); // text
};
const toCell = (v) => {
  if (v == null) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'text', value: String(v) };
};

export async function startFakeTurso() {
  const db = new DatabaseSync(':memory:');
  const log = []; // every statement run, in order (sql only)

  function runStmt(stmt) {
    log.push(stmt.sql);
    const st = db.prepare(stmt.sql);
    const args = (stmt.args || []).map(toArg);
    const cols = st.columns().map((c) => ({ name: c.name }));
    if (cols.length) {
      const rows = st.all(...args).map((r) => cols.map((c) => toCell(r[c.name])));
      return { cols, rows, affected_row_count: 0 };
    }
    const info = st.run(...args);
    return { cols: [], rows: [], affected_row_count: Number(info.changes) };
  }

  function evalCond(c, results, errors) {
    switch (c.type) {
      case 'ok': return results[c.step] != null && errors[c.step] == null;
      case 'error': return errors[c.step] != null;
      case 'not': return !evalCond(c.cond, results, errors);
      case 'and': return c.conds.every((x) => evalCond(x, results, errors));
      case 'or': return c.conds.some((x) => evalCond(x, results, errors));
      case 'is_autocommit': return !db.isTransaction;
      default: throw new Error('unsupported condition ' + c.type);
    }
  }

  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const results = [];
    for (const r of body.requests || []) {
      if (r.type === 'close') { results.push({ type: 'ok', response: { type: 'close' } }); continue; }
      if (r.type === 'execute') {
        try { results.push({ type: 'ok', response: { type: 'execute', result: runStmt(r.stmt) } }); }
        catch (e) { results.push({ type: 'error', error: { message: 'SQLite error: ' + e.message, code: 'SQLITE_ERROR' } }); }
        continue;
      }
      if (r.type === 'batch') {
        const stepResults = [], stepErrors = [];
        r.batch.steps.forEach((s, i) => {
          stepResults[i] = null; stepErrors[i] = null;
          if (s.condition && !evalCond(s.condition, stepResults, stepErrors)) return; // skipped
          try { stepResults[i] = runStmt(s.stmt); }
          catch (e) { stepErrors[i] = { message: 'SQLite error: ' + e.message, code: 'SQLITE_ERROR' }; }
        });
        results.push({ type: 'ok', response: { type: 'batch', result: { step_results: stepResults, step_errors: stepErrors } } });
        continue;
      }
      results.push({ type: 'error', error: { message: 'unsupported request ' + r.type } });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ baton: null, base_url: null, results }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    db, log,
    url: `http://127.0.0.1:${server.address().port}`,
    env: { TURSO_URL: `http://127.0.0.1:${server.address().port}`, TURSO_TOKEN: 'x' },
    close: () => new Promise((r) => server.close(r)),
  };
}
