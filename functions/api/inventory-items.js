import { touchSyncMeta } from './meta.js';

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
  const data = await res.json();
  // The pipeline endpoint returns HTTP 200 even when an individual statement
  // inside it fails (e.g. a UNIQUE violation on inventory_items.name) -- the
  // failure only shows up per-result. Without this check, onRequestPatch's
  // rename transaction would report success (and its BEGIN would never
  // ROLLBACK) even when the UPDATE it depends on silently did nothing.
  for (const r of data.results) {
    if (r.type !== 'ok') throw new Error('Statement failed: ' + JSON.stringify(r.error || r));
  }
  return data;
}

const T = v => ({ type: 'text',    value: v == null ? '' : String(v) });
const F = v => ({ type: 'float',   value: v == null ? 0 : Number(v) });
const I = v => ({ type: 'integer', value: v == null ? '0' : String(Math.round(Number(v))) });
function cell(c) { return (!c || c.type === 'null') ? null : c.value; }

function toItem(row) {
  return {
    id:            Number(cell(row[0])),
    name:          cell(row[1]) || '',
    bottle_size:   cell(row[2]) != null ? Number(cell(row[2])) : null,
    daily_dose:    cell(row[3]) != null ? Number(cell(row[3])) : null,
    annual_sale:   cell(row[4]) || '',
    off_cycle_sale: cell(row[5]) || '',
    anyday:        cell(row[6]) || '',
    barcode:       cell(row[7]) || '',
    sort_order:    cell(row[8]) != null ? Number(cell(row[8])) : 0,
  };
}

const SEL = 'SELECT id,name,bottle_size,daily_dose,annual_sale,off_cycle_sale,anyday,barcode,sort_order FROM inventory_items';
const UPSERT = `
  INSERT INTO inventory_items (name,bottle_size,daily_dose,annual_sale,off_cycle_sale,anyday,barcode,sort_order)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(name) DO UPDATE SET
    bottle_size=excluded.bottle_size, daily_dose=excluded.daily_dose,
    annual_sale=excluded.annual_sale, off_cycle_sale=excluded.off_cycle_sale,
    anyday=excluded.anyday, barcode=excluded.barcode, sort_order=excluded.sort_order`;

export async function onRequestGet({ env }) {
  const r = await pipeline(env, [
    { type: 'execute', stmt: { sql: SEL + ' ORDER BY sort_order, name COLLATE NOCASE' } },
    { type: 'close' },
  ]);
  return Response.json(r.results[0].response.result.rows.map(toItem));
}

export async function onRequestPost({ request, env }) {
  const url  = new URL(request.url);
  const body = await request.json();

  if (url.searchParams.get('bulk') === '1') {
    const items = Array.isArray(body) ? body : [];
    if (!items.length) return Response.json({ ok: true, count: 0 });
    const stmts = items.map((item, i) => ({
      type: 'execute',
      stmt: {
        sql: UPSERT,
        args: [T(item.name), F(item.bottle_size), F(item.daily_dose),
               T(item.annual_sale), T(item.off_cycle_sale), T(item.anyday),
               T(item.barcode), I(item.sort_order ?? i)],
      },
    }));
    await pipeline(env, [...stmts, { type: 'close' }]);
    const updated_at = await touchSyncMeta(env);
    return Response.json({ ok: true, count: items.length, updated_at });
  }

  const { name, bottle_size, daily_dose, annual_sale, off_cycle_sale, anyday, barcode, sort_order } = body;
  await pipeline(env, [
    { type: 'execute', stmt: { sql: UPSERT, args: [T(name), F(bottle_size), F(daily_dose), T(annual_sale), T(off_cycle_sale), T(anyday), T(barcode), I(sort_order ?? 0)] } },
    { type: 'close' },
  ]);
  const updated_at = await touchSyncMeta(env);
  return Response.json({ ok: true, updated_at });
}

export async function onRequestPatch({ request, env }) {
  const url = new URL(request.url);
  const id  = url.searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });

  const body    = await request.json();
  const allowed = ['name','bottle_size','daily_dose','annual_sale','off_cycle_sale','anyday','barcode','sort_order'];
  const entries = Object.entries(body).filter(([k]) => allowed.includes(k));
  if (!entries.length) return Response.json({ error: 'no valid fields' }, { status: 400 });

  const setCols = entries.map(([k]) => `${k} = ?`).join(', ');
  const args = [
    ...entries.map(([k, v]) =>
      ['bottle_size','daily_dose'].includes(k) ? F(v) :
      k === 'sort_order' ? I(v) : T(v)
    ),
    I(id),
  ];

  const newName = entries.find(([k]) => k === 'name')?.[1];
  try {
    if (newName != null && String(newName).trim()) {
      const trimmedNew = String(newName).trim();
      // Renaming the catalog row and re-pointing its historical inventory_log
      // rows (matched by name, not id) to the new name must succeed or fail
      // together -- otherwise on-hand history silently orphans under whichever
      // name didn't make it through. A UNIQUE violation on inventory_items.name
      // is the one failure this needs to guard against, and per SQLite's
      // default ABORT conflict behavior that only discards the failing
      // statement's own change, not the whole transaction -- a later COMMIT in
      // the same pipeline call still commits whatever DID succeed, so a
      // collision detected only after the fact can't be rolled back reliably.
      // Check for it up front instead, before either table is touched.
      const cur = await pipeline(env, [
        { type: 'execute', stmt: { sql: 'SELECT name FROM inventory_items WHERE id = ?', args: [I(id)] } },
        { type: 'execute', stmt: { sql: 'SELECT name FROM inventory_items WHERE lower(name) = lower(?) AND id != ?', args: [T(trimmedNew), I(id)] } },
        { type: 'close' },
      ]);
      const oldName = cell(cur.results[0]?.response?.result?.rows?.[0]?.[0]);
      const collisionRow = cur.results[1]?.response?.result?.rows?.[0]?.[0];
      if (collisionRow) {
        return Response.json({ error: `An item named "${cell(collisionRow)}" already exists` }, { status: 409 });
      }
      await pipeline(env, [
        { type: 'execute', stmt: { sql: 'BEGIN' } },
        { type: 'execute', stmt: { sql: `UPDATE inventory_items SET ${setCols} WHERE id = ?`, args } },
        ...(oldName ? [{ type: 'execute', stmt: {
            sql: 'UPDATE inventory_log SET item = ? WHERE lower(item) = lower(?)',
            args: [T(trimmedNew), T(oldName)],
          } }] : []),
        { type: 'execute', stmt: { sql: 'COMMIT' } },
        { type: 'close' },
      ]);
    } else {
      await pipeline(env, [
        { type: 'execute', stmt: { sql: `UPDATE inventory_items SET ${setCols} WHERE id = ?`, args } },
        { type: 'close' },
      ]);
    }
  } catch (e) {
    return Response.json({ error: String(e && e.message || e) }, { status: 409 });
  }
  const updated_at = await touchSyncMeta(env);
  return Response.json({ ok: true, updated_at });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const id  = url.searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  await pipeline(env, [
    { type: 'execute', stmt: { sql: 'DELETE FROM inventory_items WHERE id = ?', args: [I(id)] } },
    { type: 'close' },
  ]);
  const updated_at = await touchSyncMeta(env);
  return Response.json({ ok: true, updated_at });
}
