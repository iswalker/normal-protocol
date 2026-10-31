/* /api/orders — read + replace-all for the Supplement Board's Orders domain.
   Backed by Turso (order_months, orders, order_items). Mirrors the HTTP
   pipeline pattern used by functions/api/intakes.js.

   GET   -> { months:[...], orders:[...], items:[...] }  (numeric fields coerced)
   PATCH -> body { months, orders, items }, each { add:[rows], set:[{key, cols}],
            del:[keys] }: ONLY what the sending tab changed. A row it didn't touch
            is never read or written, so a tab holding an old copy of the board
            can't overwrite what another device did to other rows. Applied in one
            transaction. This is what the board uses to save.
   PUT   -> body { months, orders, items }; replaces all three tables atomically.
            Whole-board overwrite: kept for restore/admin scripts, not used by
            the board any more. */

import { touchSyncMeta, touchSyncMetaDetailed } from "./meta.js";

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
    // a batch reports each step's failure inside an otherwise "ok" result
    const errs = r.response && r.response.type === "batch" ? r.response.result.step_errors || [] : [];
    const bad = errs.find((e) => e);
    if (bad) throw new Error("Statement failed: " + JSON.stringify(bad));
  }
  return data.results;
}

const exec = (sql, args) => ({ type: "execute", stmt: args ? { sql, args } : { sql } });

// All-or-nothing. A plain pipeline keeps running after a statement fails, so a
// BEGIN ... COMMIT sent that way COMMITS whatever succeeded and only then
// reports the error -- half a save, and (since the caller bails out on the
// error) no change notice either. A conditional batch runs each step only if
// the one before it worked, so one failure skips the rest, including COMMIT,
// and the ROLLBACK step (which runs whenever COMMIT didn't) undoes the lot.
function tx(stmts) {
  const steps = [{ stmt: { sql: "BEGIN" } }];
  for (const s of stmts) steps.push({ stmt: s, condition: { type: "ok", step: steps.length - 1 } });
  const last = steps.length - 1;
  steps.push({ stmt: { sql: "COMMIT" }, condition: { type: "ok", step: last } });
  steps.push({ stmt: { sql: "ROLLBACK" }, condition: { type: "not", cond: { type: "ok", step: last + 1 } } });
  return { type: "batch", batch: { steps } };
}
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

// Add recur columns if they don't exist yet. This used to run two ALTER
// TABLE round-trips to Turso on EVERY GET and PUT -- after the first-ever
// call they always fail (column already exists) and get swallowed, but
// still cost the full network latency every time. Cache success for the
// life of this isolate so a warm isolate skips both calls entirely; a cold
// start still self-heals on its first request.
let schemaEnsured = false;
async function ensureSchema(env) {
  if (schemaEnsured) return;
  for (const sql of [
    "ALTER TABLE order_items ADD COLUMN recur INTEGER",
    "ALTER TABLE order_items ADD COLUMN recur_source TEXT",
    "ALTER TABLE order_months ADD COLUMN notes TEXT",
    "ALTER TABLE order_items ADD COLUMN autoship_link TEXT",
    "ALTER TABLE order_items ADD COLUMN autoship_next_date TEXT",
    "ALTER TABLE orders ADD COLUMN autoship_link TEXT",
    "ALTER TABLE orders ADD COLUMN autoship_next_date TEXT",
    // Orders/items used to be matched to their month by NAME ALONE ("Jun"),
    // ambiguous once two different calendar years' "Jun" coexist on the
    // board (the forward-fill window and recurring projections both
    // routinely cross a year boundary) -- see fromApi's own comment on the
    // client side for the full story. These let the client key by
    // (month, year) instead, self-healing existing NULL-year rows the next
    // time the board is edited (every save rewrites the whole board).
    "ALTER TABLE orders ADD COLUMN year INTEGER",
    "ALTER TABLE order_items ADD COLUMN year INTEGER",
    // The Autoship date the user has signed off on ("approved") -- stored as
    // the DATE itself rather than a boolean, so the approval is only ever
    // valid for that one scheduled date: once the autoship advances to its
    // next date (or the date is edited) the stored value no longer matches
    // autoship_next_date and it simply reads as unapproved again, with no
    // reset logic to keep in sync anywhere.
    "ALTER TABLE orders ADD COLUMN autoship_approved TEXT",
    "ALTER TABLE order_items ADD COLUMN autoship_approved TEXT",
    // "Launch Preemptively": this shipment is really placed in the PREVIOUS
    // month though it's tracked in this one. Tri-state: NULL = automatic (on
    // exactly when the shipment's own autoship date falls before its month --
    // derived on the client, so it follows the date), 1 / 0 = the user forced
    // it on / off.
    "ALTER TABLE orders ADD COLUMN preemptive INTEGER",
  ]) {
    try { await pipeline(env, [exec(sql)]); } catch { /* already exists */ }
  }
  await fixMonthsKey(env);
  schemaEnsured = true;
}

// order_months was created with "month TEXT PRIMARY KEY" -- the month NAME alone
// -- back when the board only ever held one calendar year. Now that it holds
// "Jun 2026" and "Jun 2027" together, the second "Jun" could never be inserted,
// so every save of the board failed on it. Rebuild the table keyed by
// (month, year) instead (a handful of rows).
async function fixMonthsKey(env) {
  const res = await pipeline(env, [exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'order_months'")]);
  const ddl = (rowsFrom(res[0])[0] || {}).sql || "";
  if (!/month\s+TEXT\s+PRIMARY\s+KEY/i.test(ddl)) return; // already rebuilt
  await pipeline(env, [tx([
    { sql: "DROP TABLE IF EXISTS order_months_new" },
    { sql: "CREATE TABLE order_months_new (month TEXT NOT NULL, year INTEGER, position INTEGER, notes TEXT)" },
    { sql: "INSERT INTO order_months_new (month, year, position, notes) SELECT month, year, position, notes FROM order_months" },
    { sql: "DROP TABLE order_months" },
    { sql: "ALTER TABLE order_months_new RENAME TO order_months" },
    { sql: "CREATE UNIQUE INDEX IF NOT EXISTS order_months_month_year ON order_months (month, year)" },
  ])]);
}

export async function onRequestGet({ env }) {
  try {
    await ensureSchema(env);
    const results = await pipeline(env, [
      exec("SELECT month, year, position, notes FROM order_months ORDER BY position"),
      exec("SELECT order_id, month, year, merchant, position, status, notes, autoship_link, autoship_next_date, autoship_approved, preemptive FROM orders ORDER BY position"),
      exec(
        `SELECT order_item_id, order_id, month, year, block_position, item_position, supplement,
                price_per_bottle, order_qty_bottles, include_in_total, notes, untracked,
                recur, recur_source, autoship_link, autoship_next_date, autoship_approved
         FROM order_items ORDER BY block_position, item_position`
      ),
    ]);
    const months = rowsFrom(results[0]).map((m) => ({
      month: m.month, year: num(m.year), position: num(m.position), notes: m.notes || "",
    }));
    const orders = rowsFrom(results[1]).map((o) => ({
      order_id: o.order_id, month: o.month, year: num(o.year), merchant: o.merchant,
      position: num(o.position), status: o.status, notes: o.notes,
      autoship_link: o.autoship_link || null,
      autoship_next_date: o.autoship_next_date || null,
      autoship_approved: o.autoship_approved || null,
      preemptive: o.preemptive == null ? null : num(o.preemptive),
    }));
    const items = rowsFrom(results[2]).map((it) => ({
      order_item_id: it.order_item_id, order_id: it.order_id, month: it.month, year: num(it.year),
      block_position: num(it.block_position), item_position: num(it.item_position),
      supplement: it.supplement,
      // Preserve a genuinely NULL price as null (not 0) -- the board uses a
      // blank Price as a meaningful signal (quantity mode's withdraw trigger).
      price_per_bottle: it.price_per_bottle == null ? null : num(it.price_per_bottle),
      order_qty_bottles: num(it.order_qty_bottles) || 0,
      include_in_total: num(it.include_in_total) ? true : false, notes: it.notes,
      untracked: num(it.untracked) ? true : false,
      recur: it.recur ? num(it.recur) : null,
      recur_source: it.recur_source || null,
      autoship_link: it.autoship_link || null,
      autoship_next_date: it.autoship_next_date || null,
      autoship_approved: it.autoship_approved || null,
    }));
    return Response.json({ months, orders, items });
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

  await ensureSchema(env);

  const reqs = [
    exec("DELETE FROM order_items"),
    exec("DELETE FROM orders"),
    exec("DELETE FROM order_months"),
  ];
  for (const m of months) {
    reqs.push(exec(
      "INSERT INTO order_months (month, year, position, notes) VALUES (?, ?, ?, ?)",
      [T(m.month), I(m.year), I(m.position), T(m.notes)]
    ));
  }
  for (const o of orders) {
    reqs.push(exec(
      "INSERT INTO orders (order_id, month, year, merchant, position, status, notes, autoship_link, autoship_next_date, autoship_approved, preemptive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [T(o.order_id), T(o.month), I(o.year), T(o.merchant), I(o.position), T(o.status), T(o.notes), T(o.autoship_link), T(o.autoship_next_date), T(o.autoship_approved), I(o.preemptive)]
    ));
  }
  for (const it of items) {
    reqs.push(exec(
      `INSERT INTO order_items
         (order_item_id, order_id, month, year, block_position, item_position, supplement,
          price_per_bottle, order_qty_bottles, include_in_total, notes, untracked,
          recur, recur_source, autoship_link, autoship_next_date, autoship_approved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [T(it.order_item_id), T(it.order_id), T(it.month), I(it.year), I(it.block_position), I(it.item_position),
       T(it.supplement), F(it.price_per_bottle), F(it.order_qty_bottles), I(it.include_in_total ? 1 : 0),
       T(it.notes), I(it.untracked ? 1 : 0),
       it.recur ? I(it.recur) : { type: "null" }, it.recur_source ? T(it.recur_source) : { type: "null" },
       T(it.autoship_link), T(it.autoship_next_date), T(it.autoship_approved)]
    ));
  }

  try {
    await pipeline(env, [tx(reqs.map((r) => r.stmt))]);
    const updated_at = await touchSyncMeta(env);
    return Response.json({ ok: true, updated_at });
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) }, { status: 502 });
  }
}

// ── PATCH: write only what changed ──────────────────────────────────────────
// Column lists are fixed here (the client's names are only ever looked up in
// them, never put into SQL). T text, I integer, F real.
const TABLES = {
  months: { table: "order_months", key: { month: T, year: I }, cols: { position: I, notes: T } },
  orders: {
    table: "orders", key: { order_id: T },
    cols: { month: T, year: I, merchant: T, position: I, status: T, notes: T, autoship_link: T, autoship_next_date: T, autoship_approved: T, preemptive: I },
  },
  items: {
    table: "order_items", key: { order_item_id: T },
    cols: {
      order_id: T, month: T, year: I, block_position: I, item_position: I, supplement: T,
      price_per_bottle: F, order_qty_bottles: F, include_in_total: I, notes: T, untracked: I,
      recur: I, recur_source: T, autoship_link: T, autoship_next_date: T, autoship_approved: T,
    },
  },
};

// "WHERE <key> = ?" -- a NULL year (an old row) has to be matched with IS
const keyWhere = (spec) => Object.keys(spec.key).map((k) => (k === "year" ? "year IS ?" : k + " = ?")).join(" AND ");
const keyArgs = (spec, key) => Object.entries(spec.key).map(([k, enc]) => enc(key && key[k]));

function patchStatements(body) {
  const out = [];
  for (const [name, spec] of Object.entries(TABLES)) {
    const part = body && body[name];
    if (!part || typeof part !== "object") continue;
    const keyCols = Object.keys(spec.key);
    const colNames = Object.keys(spec.cols);
    for (const key of Array.isArray(part.del) ? part.del : []) {
      out.push({ sql: `DELETE FROM ${spec.table} WHERE ${keyWhere(spec)}`, args: keyArgs(spec, key) });
    }
    for (const row of Array.isArray(part.add) ? part.add : []) {
      // a brand-new row; if the id is somehow already there (the same ghost
      // created from two devices) it is replaced rather than failing the save
      const names = [...keyCols, ...colNames];
      const conflict = name === "months" ? "month, year" : keyCols[0];
      out.push({
        sql: `INSERT INTO ${spec.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT(${conflict}) DO UPDATE SET ${colNames.map((c) => `${c} = excluded.${c}`).join(", ")}`,
        args: [...keyArgs(spec, row), ...colNames.map((c) => spec.cols[c](row && row[c]))],
      });
    }
    for (const e of Array.isArray(part.set) ? part.set : []) {
      const cols = Object.keys((e && e.cols) || {}).filter((c) => Object.prototype.hasOwnProperty.call(spec.cols, c));
      if (!cols.length) continue;
      out.push({
        sql: `UPDATE ${spec.table} SET ${cols.map((c) => c + " = ?").join(", ")} WHERE ${keyWhere(spec)}`,
        args: [...cols.map((c) => spec.cols[c](e.cols[c])), ...keyArgs(spec, e.key)],
      });
    }
  }
  return out;
}

export async function onRequestPatch({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const stmts = patchStatements(body);
  try {
    await ensureSchema(env);
    if (!stmts.length) return Response.json({ ok: true, applied: 0 });
    await pipeline(env, [tx(stmts)]);
    const { updated_at, prev } = await touchSyncMetaDetailed(env);
    return Response.json({ ok: true, applied: stmts.length, updated_at, prev_updated_at: prev });
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) }, { status: 502 });
  }
}
