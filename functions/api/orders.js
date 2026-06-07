/* /api/orders — read + replace-all for the Supplement Board's Orders domain.
   Backed by Turso (order_months, orders, order_items). Mirrors the HTTP
   pipeline pattern used by functions/api/intakes.js.

   GET  -> { months:[...], orders:[...], items:[...] }  (numeric fields coerced)
   PUT  -> body { months, orders, items }; replaces all three tables atomically.
           This matches the board's existing serialize()-and-save model: the
           client sends the whole board, the server rewrites it in one txn. */

function httpUrl(env) {
  // the pipeline endpoint is https://, even when TURSO_URL is given as libsql://
  return env.TURSO_URL.replace(/^libsql:\/\//, "https://").replace(/\/$/, "");
}

async function pipeline(env, requests) {
  const res = await fetch(`${httpUrl(env)}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TURSO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests: [...requests, { type: "close" }] }),
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
  const data = await res.json();
  for (const r of data.results) {
    if (r.type !== "ok") throw new Error("Statement failed: " + JSON.stringify(r.error || r));
  }
  return data.results;
}

const exec = (sql, args) => ({ type: "execute", stmt: args ? { sql, args } : { sql } });
const T = (v) => (v == null ? { type: "null" } : { type: "text", value: String(v) });
const I = (v) => (v == null || v === "" ? { type: "null" } : { type: "integer", value: String(Math.trunc(Number(v))) });
const F = (v) => (v == null || v === "" ? { type: "null" } : { type: "float", value: Number(v) });

function cellValue(cell) {
  // Turso v2 returns NULL cells as { type: "null" } (no `value`)
  return cell == null || cell.type === "null" ? null : cell.value;
}
function rowsFrom(result) {
  const r = result.response.result;
  const cols = r.cols.map((c) => c.name);
  return r.rows.map((row) =>
    Object.fromEntries(cols.map((c, i) => [c, cellValue(row[i])])));
}
const num = (v) => (v == null ? null : Number(v));

export async function onRequestGet({ env }) {
  try {
    const results = await pipeline(env, [
      exec("SELECT month, year, position FROM order_months ORDER BY position"),
      exec("SELECT order_id, month, merchant, position, status, notes FROM orders ORDER BY position"),
      exec(
        `SELECT order_item_id, order_id, month, block_position, item_position, supplement,
                price_per_bottle, order_qty_bottles, include_in_total, notes
         FROM order_items ORDER BY block_position, item_position`
      ),
    ]);
    const months = rowsFrom(results[0]).map((m) => ({
      month: m.month, year: num(m.year), position: num(m.position),
    }));
    const orders = rowsFrom(results[1]).map((o) => ({
      order_id: o.order_id, month: o.month, merchant: o.merchant,
      position: num(o.position), status: o.status, notes: o.notes,
    }));
    const items = rowsFrom(results[2]).map((it) => ({
      order_item_id: it.order_item_id, order_id: it.order_id, month: it.month,
      block_position: num(it.block_position), item_position: num(it.item_position),
      supplement: it.supplement, price_per_bottle: num(it.price_per_bottle) || 0,
      order_qty_bottles: num(it.order_qty_bottles) || 0,
      include_in_total: num(it.include_in_total) ? true : false, notes: it.notes,
    }));
    return Response.json({ months, orders, items }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) }, { status: 502 });
  }
}

export async function onRequestPut({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const months = Array.isArray(body.months) ? body.months : [];
  const orders = Array.isArray(body.orders) ? body.orders : [];
  const items = Array.isArray(body.items) ? body.items : [];

  const reqs = [
    exec("BEGIN"),
    exec("DELETE FROM order_items"),
    exec("DELETE FROM orders"),
    exec("DELETE FROM order_months"),
  ];
  for (const m of months) {
    reqs.push(exec(
      "INSERT INTO order_months (month, year, position) VALUES (?, ?, ?)",
      [T(m.month), I(m.year), I(m.position)]
    ));
  }
  for (const o of orders) {
    reqs.push(exec(
      "INSERT INTO orders (order_id, month, merchant, position, status, notes) VALUES (?, ?, ?, ?, ?, ?)",
      [T(o.order_id), T(o.month), T(o.merchant), I(o.position), T(o.status), T(o.notes)]
    ));
  }
  for (const it of items) {
    reqs.push(exec(
      `INSERT INTO order_items
         (order_item_id, order_id, month, block_position, item_position, supplement, price_per_bottle, order_qty_bottles, include_in_total, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [T(it.order_item_id), T(it.order_id), T(it.month), I(it.block_position), I(it.item_position),
       T(it.supplement), F(it.price_per_bottle), F(it.order_qty_bottles), I(it.include_in_total ? 1 : 0), T(it.notes)]
    ));
  }
  reqs.push(exec("COMMIT"));

  try {
    await pipeline(env, reqs);
    return Response.json({ ok: true });
  } catch (e) {
    try { await pipeline(env, [exec("ROLLBACK")]); } catch {}
    return Response.json({ error: String(e && e.message || e) }, { status: 502 });
  }
}
