/* Tiny Turso HTTP (v2 pipeline) client for local migration/seed scripts.
   Reads TURSO_URL + TURSO_TOKEN from .dev.vars (git-ignored). Mirrors the
   request shape used by the Pages Functions in functions/api/. */
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));

async function loadEnv() {
  const txt = await readFile(join(ROOT, '.dev.vars'), 'utf8');
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.TURSO_URL || !env.TURSO_TOKEN) throw new Error('Missing TURSO_URL/TURSO_TOKEN in .dev.vars');
  // the HTTP pipeline endpoint is https://, even when the URL is given as libsql://
  env.HTTP_URL = env.TURSO_URL.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  return env;
}

/** Run a list of SQL statements. Each item is a string or { sql, args }.
    args use Turso typed values, e.g. [{ type:'text', value:'x' }]. */
export async function run(statements) {
  const env = await loadEnv();
  const requests = statements.map((s) => ({
    type: 'execute',
    stmt: typeof s === 'string' ? { sql: s } : s,
  }));
  requests.push({ type: 'close' });

  const res = await fetch(`${env.HTTP_URL}/v2/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TURSO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.results.map((r) => {
    if (r.type !== 'ok') throw new Error('Statement failed: ' + JSON.stringify(r));
    const result = r.response.result;
    if (!result || !result.cols) return null; // non-SELECT
    const cols = result.cols.map((c) => c.name);
    return result.rows.map((row) =>
      Object.fromEntries(cols.map((c, i) => [c, row[i] == null || row[i].type === 'null' ? null : row[i].value])));
  });
}

export const text = (value) => ({ type: 'text', value: String(value) });
export const int = (value) => ({ type: 'integer', value: String(value) });
export const real = (value) => ({ type: 'float', value: Number(value) });
