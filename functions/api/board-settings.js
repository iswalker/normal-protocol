/* /api/board-settings — small board-wide settings synced across devices via
   Turso, starting with the "Pin Merchant" filter chips (see
   pinMerchant/unpinMerchant/renderPinnedMerchants in index.html). These used
   to live in localStorage (per-device only, which is why pinning a merchant
   on one device never showed up on another) -- one row keyed by id=1, same
   shape as meta.js's sync_meta.

   GET  -> { pinnedMerchants: string[] }
   PUT  -> body { pinnedMerchants: string[] }; replaces the stored list. */

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
