/* GET ?order_id= filter, POST insert, PATCH ?id=N update type, DELETE ?item= remove all rows */
function httpUrl(env) {
  return env.TURSO_URL.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
}

async function pipeline(env, requests) {
  const res = await fetch(`${httpUrl(env)}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURSO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Turso ${res.status}: ${await res.text()}`);
  return res.json();
}

const exec = (sql, args) => ({ type: 'execute', stmt: args ? { sql, args } : { sql } });
const T = (v) => (v == null ? { type: 'null' } : { type: 'text', value: String(v) });
const F = (v) => (v == null || v === '' ? { type: 'null' } : { type: 'float', value: Number(v) });

const CREATE = exec(
  'CREATE TABLE IF NOT EXISTS inventory_log (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, type TEXT NOT NULL DEFAULT \'Reset\', logged_on TEXT NOT NULL, order_id TEXT)'
);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('order_id');
  const sql = orderId
    ? 'SELECT * FROM inventory_log WHERE order_id = ? ORDER BY id'
    : 'SELECT * FROM inventory_log ORDER BY id';
  const args = orderId ? [T(orderId)] : undefined;
  const data = await pipeline(env, [CREATE, exec(sql, args)]);
  const rows = data.results[1]?.response?.result?.rows ?? [];
  const cols = data.results[1]?.response?.result?.cols ?? [];
  const records = rows.map((row) =>
    Object.fromEntries(cols.map((c, i) => [c.name, row[i]?.value ?? null]))
  );
  return Response.json(records);
}

export async function onRequestPost({ request, env }) {
  const { item, amount, type, logged_on, order_id } = await request.json();
  const data = await pipeline(env, [
    CREATE,
    exec(
      'INSERT INTO inventory_log (item, amount, type, logged_on, order_id) VALUES (?, ?, ?, ?, ?)',
      [T(item), F(amount), T(type ?? 'Reset'), T(logged_on), T(order_id)]
    ),
    exec('SELECT last_insert_rowid() as id'),
  ]);
  const id = data.results[2]?.response?.result?.rows?.[0]?.[0]?.value;
  return Response.json({ ok: true, id });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const item = url.searchParams.get('item');
  if (!item) return Response.json({ error: 'missing ?item=' }, { status: 400 });
  await pipeline(env, [CREATE, exec('DELETE FROM inventory_log WHERE item = ?', [T(item)])]);
  return Response.json({ ok: true });
}

export async function onRequestPatch({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ error: 'missing ?id=' }, { status: 400 });
  const body = await request.json();
  const fields = [];
  const args = [];
  if (body.type !== undefined) { fields.push('type = ?'); args.push(T(body.type)); }
  if (body.amount !== undefined) { fields.push('amount = ?'); args.push(F(body.amount)); }
  if (!fields.length) return Response.json({ error: 'nothing to update' }, { status: 400 });
  args.push(T(id));
  await pipeline(env, [CREATE, exec(`UPDATE inventory_log SET ${fields.join(', ')} WHERE id = ?`, args)]);
  return Response.json({ ok: true });
}
