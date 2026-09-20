/* /api/board-settings — small board-wide settings synced across devices via
   Turso, starting with the "Pin Merchant" filter chips (see
   pinMerchant/unpinMerchant/renderPinnedMerchants in index.html). These used
   to live in localStorage (per-device only, which is why pinning a merchant
   on one device never showed up on another) -- one row keyed by id=1, same
   shape as meta.js's sync_meta.

   GET  -> { pinnedMerchants: string[] }
   PUT  -> body { pinnedMerchants: string[] }; replaces the stored list.
           Used only for reordering (see index.html's Sortable onEnd) -- the
           client fetches the current server list and reconciles its drag
           order against it right before calling this, rather than trusting
           whatever it loaded at page boot, but this is still a plain
           overwrite and not immune to a concurrent write landing in that
           gap. Reordering losing a race is cheap to redo; losing track of
           WHICH merchants are pinned at all is not.
   POST -> body { action: 'pin'|'unpin', name }; the actual "which merchants
           are pinned" mutation, done as a single atomic SQL UPDATE (SQLite's
           JSON1 functions add/remove the name against whatever the row's
           CURRENT value is at execution time -- see onRequestPost) instead
           of a read-in-JS-then-overwrite round trip. That read-then-write
           shape is exactly what silently wiped out real Autoship data
           earlier in this project (a card's PUT payload built from a
           possibly-stale in-memory copy, clobbering whatever changed
           between the read and the write) -- same class of bug, this closes
           it for pin/unpin specifically by never holding the list in
           application code as a value to write back at all. */

import { touchSyncMeta } from "./meta.js";

function httpUrl(env) {
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

const CREATE = exec(
  "CREATE TABLE IF NOT EXISTS board_settings (id INTEGER PRIMARY KEY CHECK (id = 1), pinned_merchants TEXT)"
);

export async function onRequestGet({ env }) {
  try {
    const results = await pipeline(env, [CREATE, exec("SELECT pinned_merchants FROM board_settings WHERE id = 1")]);
    const cell = results[1].response.result.rows[0]?.[0];
    const raw = cell && cell.type !== "null" ? cell.value : null;
    let pinnedMerchants = [];
    if (raw) {
      try {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) pinnedMerchants = v.filter((s) => typeof s === "string");
      } catch { /* corrupt row -- fall back to empty rather than fail the load */ }
    }
    return Response.json({ pinnedMerchants }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) }, { status: 502 });
  }
}

export async function onRequestPut({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const pinnedMerchants = Array.isArray(body.pinnedMerchants)
    ? body.pinnedMerchants.filter((s) => typeof s === "string")
    : [];
  try {
    await pipeline(env, [
      CREATE,
      exec(
        "INSERT INTO board_settings (id, pinned_merchants) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET pinned_merchants = excluded.pinned_merchants",
        [T(JSON.stringify(pinnedMerchants))]
      ),
    ]);
    const updated_at = await touchSyncMeta(env);
    return Response.json({ ok: true, updated_at }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) }, { status: 502 });
  }
}

// Seeds the row with a real '[]' (not NULL) the first time, so the JSON1
// expressions in onRequestPost always have valid JSON to operate on even on
// a brand-new board that's never called PUT.
const SEED = exec("INSERT INTO board_settings (id, pinned_merchants) VALUES (1, '[]') ON CONFLICT(id) DO NOTHING");

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const action = body.action;
  const name = String(body.name || "").trim();
  if (action !== "pin" && action !== "unpin") return Response.json({ error: "action must be 'pin' or 'unpin'" }, { status: 400 });
  if (!name) return Response.json({ error: "Missing name" }, { status: 400 });

  // Single UPDATE statement per action, computed entirely by SQLite's JSON1
  // functions against whatever the row's value is AT THE MOMENT THIS
  // STATEMENT RUNS -- there is no separate "read the list into JS, decide
  // the new value, write it back" step for this server to have a stale copy
  // of in the first place, so two of these landing back to back (from two
  // different devices) can't clobber each other the way a full-array
  // overwrite built from a stale client-side snapshot could.
  const mutate = action === "pin"
    ? exec(
        `UPDATE board_settings SET pinned_merchants = CASE
           WHEN EXISTS (SELECT 1 FROM json_each(pinned_merchants) WHERE lower(value) = lower(?))
           THEN pinned_merchants
           ELSE json_insert(pinned_merchants, '$[#]', ?)
         END WHERE id = 1`,
        [T(name), T(name)]
      )
    : exec(
        `UPDATE board_settings SET pinned_merchants = (
           SELECT COALESCE(json_group_array(value), '[]') FROM json_each(pinned_merchants) WHERE lower(value) != lower(?)
         ) WHERE id = 1`,
        [T(name)]
      );

  try {
    const results = await pipeline(env, [
      CREATE,
      SEED,
      mutate,
      exec("SELECT pinned_merchants FROM board_settings WHERE id = 1"),
    ]);
    const cell = results[3].response.result.rows[0]?.[0];
    const raw = cell && cell.type !== "null" ? cell.value : "[]";
    let pinnedMerchants = [];
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) pinnedMerchants = v.filter((s) => typeof s === "string");
    } catch { /* shouldn't happen -- the column only ever holds what these statements wrote */ }
    const updated_at = await touchSyncMeta(env);
    return Response.json({ ok: true, pinnedMerchants, updated_at }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) }, { status: 502 });
  }
}
