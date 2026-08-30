/* /api/meta — a single-row "when did anything last change" timestamp.
   Touched by orders.js, inventory.js and inventory-items.js after every
   write, so the client can poll this cheap endpoint and show a "data
   changed elsewhere, refresh to see it" banner instead of trying to merge
   live updates across devices. */

function httpUrl(env) {
  return env.TURSO_URL.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
}

async function pipeline(env, requests) {
  const res = await fetch(`${httpUrl(env)}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURSO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
  });
  if (!res.ok) throw new Error(`Turso ${res.status}: ${await res.text()}`);
  const data = await res.json();
  for (const r of data.results) {
    if (r.type !== 'ok') throw new Error('Statement failed: ' + JSON.stringify(r.error || r));
  }
  return data;
}

const T = (v) => (v == null ? { type: 'null' } : { type: 'text', value: String(v) });
const CREATE = { type: 'execute', stmt: { sql: "CREATE TABLE IF NOT EXISTS sync_meta (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TEXT)" } };

export async function onRequestGet({ env }) {
  try {
    const data = await pipeline(env, [CREATE, { type: 'execute', stmt: { sql: 'SELECT updated_at FROM sync_meta WHERE id = 1' } }]);
    const row = data.results[1]?.response?.result?.rows?.[0]?.[0];
    const updated_at = row && row.type !== 'null' ? row.value : null;
    return Response.json({ updated_at }, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) }, { status: 502 });
  }
}

// Called by the other write endpoints right after a successful mutation.
// Best-effort: a failure here should never fail the write it's reporting.
export async function touchSyncMeta(env) {
  try {
    const iso = new Date().toISOString();
    await pipeline(env, [
      CREATE,
      { type: 'execute', stmt: {
        sql: 'INSERT INTO sync_meta (id, updated_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at',
        args: [T(iso)],
      } },
    ]);
    return iso;
  } catch (e) {
    console.error('touchSyncMeta failed:', e.message);
    return null;
  }
}
