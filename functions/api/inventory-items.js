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
    return Response.json({ ok: true, count: items.length });
  }

  const { name, bottle_size, daily_dose, annual_sale, off_cycle_sale, anyday, barcode, sort_order } = body;
  await pipeline(env, [
    { type: 'execute', stmt: { sql: UPSERT, args: [T(name), F(bottle_size), F(daily_dose), T(annual_sale), T(off_cycle_sale), T(anyday), T(barcode), I(sort_order ?? 0)] } },
    { type: 'close' },
  ]);
  return Response.json({ ok: true });
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
  await pipeline(env, [
    { type: 'execute', stmt: { sql: `UPDATE inventory_items SET ${setCols} WHERE id = ?`, args } },
    { type: 'close' },
  ]);
  return Response.json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const id  = url.searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  await pipeline(env, [
    { type: 'execute', stmt: { sql: 'DELETE FROM inventory_items WHERE id = ?', args: [I(id)] } },
    { type: 'close' },
  ]);
  return Response.json({ ok: true });
}
