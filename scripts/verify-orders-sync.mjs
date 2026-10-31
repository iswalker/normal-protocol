/* verify-orders-sync.mjs — the board's save endpoint (functions/api/orders.js),
   run against a fake Turso (scripts/fake-turso.mjs) holding the LEGACY table
   layout, so nothing touches the live database.

   Covers:
     - PATCH writes only the rows/columns it is given (another device's edits to
       other rows, and to other columns of the same row, survive);
     - add / set / del, NULL-year months, unknown columns ignored;
     - all-or-nothing: one bad statement undoes the whole save and says so;
     - the order_months key fix ("Jun 2026" and "Jun 2027" can coexist);
     - the response tells the writer what the change timestamp was before it
       (prev_updated_at), so a tab can tell "someone else wrote in between";
     - the whole-board PUT still works for restores.
   Run: npm run verify:sync */

import { startFakeTurso } from './fake-turso.mjs';
import { onRequestGet, onRequestPatch, onRequestPut } from '../functions/api/orders.js';

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

const t = await startFakeTurso();
const env = t.env;
const q = (sql, ...args) => t.db.prepare(sql).all(...args);

// the layout the live database has today (read from sqlite_master)
t.db.exec(`
CREATE TABLE order_months (month TEXT PRIMARY KEY, year INTEGER, position INTEGER, notes TEXT);
CREATE TABLE orders (order_id TEXT PRIMARY KEY, month TEXT NOT NULL, merchant TEXT, position INTEGER, status TEXT, notes TEXT, autoship_link TEXT, autoship_next_date TEXT, year INTEGER, autoship_approved TEXT, preemptive INTEGER);
CREATE TABLE order_items (order_item_id TEXT PRIMARY KEY, order_id TEXT, month TEXT NOT NULL, block_position INTEGER, item_position INTEGER, supplement TEXT, price_per_bottle REAL DEFAULT 0, order_qty_bottles REAL DEFAULT 0, include_in_total INTEGER DEFAULT 1, notes TEXT, untracked INTEGER DEFAULT 0, recur INTEGER, recur_source TEXT, autoship_link TEXT, autoship_next_date TEXT, year INTEGER, autoship_approved TEXT);
INSERT INTO order_months VALUES ('Jun', 2026, 1, ''), ('Jul', 2026, 2, 'july note');
INSERT INTO orders (order_id, month, year, merchant, position, status) VALUES ('o1', 'Jun', 2026, 'Blue Sky', 1, 'Staged'), ('o2', 'Jun', 2026, 'Fullscript', 2, 'Staged');
INSERT INTO order_items (order_item_id, order_id, month, year, block_position, item_position, supplement, price_per_bottle, order_qty_bottles, include_in_total, notes)
  VALUES ('i1', 'o1', 'Jun', 2026, 1, 1, 'Alpha', 10, 1, 1, 'alpha note'),
         ('i2', 'o1', 'Jun', 2026, 1, 2, 'Beta', 20, 2, 1, ''),
         ('i3', 'o2', 'Jun', 2026, 2, 1, 'Gamma', 30, 3, 0, '');
`);
const patch = async (body) => { const r = await onRequestPatch({ request: { json: async () => body }, env }); return { status: r.status, body: await r.json() }; };
const metaAt = () => q('SELECT updated_at FROM sync_meta WHERE id = 1')[0]?.updated_at ?? null;

// ── the first request migrates order_months to be keyed by (month, year) ──
const g = await (await onRequestGet({ env })).json();
check('GET works on the legacy layout and returns the 2 months', g.months.length === 2 && g.items.length === 3);
const monthsDdl = q("SELECT sql FROM sqlite_master WHERE name = 'order_months'")[0].sql;
check('order_months is no longer keyed by the month name alone', !/month\s+TEXT\s+PRIMARY\s+KEY/i.test(monthsDdl), monthsDdl);
check('…and its rows (incl. notes) survived the rebuild', JSON.stringify(q('SELECT month, year, position, notes FROM order_months ORDER BY position')) === JSON.stringify([
  { month: 'Jun', year: 2026, position: 1, notes: '' }, { month: 'Jul', year: 2026, position: 2, notes: 'july note' }]));

// ── a month name can now repeat across years ──
let r = await patch({ months: { add: [{ month: 'Jun', year: 2027, position: 3, notes: '' }] } });
check('"Jun 2027" can be saved next to "Jun 2026"', r.status === 200 && q("SELECT count(*) AS n FROM order_months WHERE month = 'Jun'")[0].n === 2, JSON.stringify(r));
check('…the response carries a change timestamp', typeof r.body.updated_at === 'string' && r.body.updated_at.length > 10);
check('…and no "previous" one yet on a brand-new meta row', r.body.prev_updated_at === null);
const t1 = r.body.updated_at;

// ── one column of one item ──
r = await patch({ items: { set: [{ key: { order_item_id: 'i1' }, cols: { include_in_total: 0 } }] } });
const i1 = q("SELECT * FROM order_items WHERE order_item_id = 'i1'")[0];
check('changing one item\'s toggle updates just that column of that row', r.status === 200 && i1.include_in_total === 0 && i1.supplement === 'Alpha' && i1.notes === 'alpha note' && i1.price_per_bottle === 10, JSON.stringify(i1));
check('…and that save was a single statement', r.body.applied === 1, JSON.stringify(r.body));
check('…the response says what the timestamp was before (our own earlier write)', r.body.prev_updated_at === t1, JSON.stringify({ prev: r.body.prev_updated_at, t1 }));
const others = q("SELECT order_item_id, include_in_total, supplement FROM order_items WHERE order_item_id IN ('i2','i3') ORDER BY order_item_id");
check('…every other item is untouched', JSON.stringify(others) === JSON.stringify([{ order_item_id: 'i2', include_in_total: 1, supplement: 'Beta' }, { order_item_id: 'i3', include_in_total: 0, supplement: 'Gamma' }]), JSON.stringify(others));

// ── another device changes things this tab never touches; our save must not undo them ──
t.db.exec("UPDATE order_items SET notes = 'edited on the phone', order_qty_bottles = 9 WHERE order_item_id = 'i2'");
t.db.exec("UPDATE order_items SET notes = 'phone note too' WHERE order_item_id = 'i1'");
t.db.exec("UPDATE orders SET status = 'Ordered' WHERE order_id = 'o2'");
r = await patch({ items: { set: [{ key: { order_item_id: 'i1' }, cols: { price_per_bottle: 11.5 } }] } });
const after = Object.fromEntries(q('SELECT order_item_id, notes, order_qty_bottles, price_per_bottle FROM order_items').map((x) => [x.order_item_id, x]));
check('an item edited elsewhere is not rewritten by an unrelated save', after.i2.notes === 'edited on the phone' && after.i2.order_qty_bottles === 9);
check('…nor are the other columns of the very item being saved', after.i1.notes === 'phone note too' && after.i1.price_per_bottle === 11.5);
check('…nor an order edited elsewhere', q("SELECT status FROM orders WHERE order_id = 'o2'")[0].status === 'Ordered');

// ── add, move, delete ──
r = await patch({
  orders: { add: [{ order_id: 'o3', month: 'Jun', year: 2027, merchant: 'New Co', position: 1, status: 'Staged', notes: '', autoship_link: null, autoship_next_date: null, autoship_approved: null, preemptive: null }], set: [{ key: { order_id: 'o1' }, cols: { merchant: 'Blue Sky Vitamin', preemptive: 1 } }] },
  items: {
    add: [{ order_item_id: 'i4', order_id: 'o3', month: 'Jun', year: 2027, block_position: 1, item_position: 1, supplement: 'Delta', price_per_bottle: null, order_qty_bottles: 4, include_in_total: 1, notes: '', untracked: 0, recur: null, recur_source: null, autoship_link: null, autoship_next_date: null, autoship_approved: null }],
    del: [{ order_item_id: 'i3' }],
  },
  months: { set: [{ key: { month: 'Jul', year: 2026 }, cols: { notes: 'new july note', position: 5 } }] },
});
check('add / set / delete in one save', r.status === 200
  && q("SELECT supplement, price_per_bottle FROM order_items WHERE order_item_id = 'i4'")[0].supplement === 'Delta'
  && q("SELECT price_per_bottle FROM order_items WHERE order_item_id = 'i4'")[0].price_per_bottle === null
  && q("SELECT count(*) AS n FROM order_items WHERE order_item_id = 'i3'")[0].n === 0
  && q("SELECT merchant, preemptive FROM orders WHERE order_id = 'o1'")[0].merchant === 'Blue Sky Vitamin'
  && q("SELECT count(*) AS n FROM orders WHERE order_id = 'o3'")[0].n === 1
  && q("SELECT notes, position FROM order_months WHERE month = 'Jul' AND year = 2026")[0].notes === 'new july note', JSON.stringify(r));
check('…and the rest of the board is as it was', q("SELECT count(*) AS n FROM order_items")[0].n === 3 && q("SELECT merchant FROM orders WHERE order_id = 'o2'")[0].merchant === 'Fullscript');

// adding something whose id is already there replaces it instead of failing the save
r = await patch({ items: { add: [{ order_item_id: 'i4', order_id: 'o3', month: 'Jun', year: 2027, block_position: 1, item_position: 1, supplement: 'Delta v2', order_qty_bottles: 4, include_in_total: 1 }] } });
check('re-adding an existing id updates it (no duplicate, no failure)', r.status === 200 && q("SELECT supplement FROM order_items WHERE order_item_id = 'i4'")[0].supplement === 'Delta v2' && q("SELECT count(*) AS n FROM order_items WHERE order_item_id = 'i4'")[0].n === 1);

// a month row from before years were stored (NULL year) is addressed with IS
t.db.exec("INSERT INTO order_months (month, year, position, notes) VALUES ('Aug', NULL, 9, '')");
r = await patch({ months: { set: [{ key: { month: 'Aug', year: null }, cols: { position: 10 } }] } });
check('a month with no year can still be updated', r.status === 200 && q("SELECT position FROM order_months WHERE month = 'Aug'")[0].position === 10);
r = await patch({ months: { del: [{ month: 'Aug', year: null }] } });
check('…and removed', r.status === 200 && q("SELECT count(*) AS n FROM order_months WHERE month = 'Aug'")[0].n === 0);

// ── only known columns ever reach the SQL ──
r = await patch({ items: { set: [{ key: { order_item_id: 'i1' }, cols: { "supplement = 'pwned', notes": 'x', no_such_col: 1, supplement: 'Alpha 2' } }] } });
check('unknown column names are ignored, known ones applied', r.status === 200 && q("SELECT supplement, notes FROM order_items WHERE order_item_id = 'i1'")[0].supplement === 'Alpha 2' && q("SELECT notes FROM order_items WHERE order_item_id = 'i1'")[0].notes === 'phone note too');
const before = metaAt();
r = await patch({});
check('an empty save does nothing (and does not move the change timestamp)', r.status === 200 && r.body.applied === 0 && metaAt() === before);
const bad = await onRequestPatch({ request: { json: async () => { throw new Error('bad json'); } }, env });
check('unparseable JSON is a 400', bad.status === 400);

// ── all or nothing ──
const snapshot = JSON.stringify(q('SELECT * FROM order_items ORDER BY order_item_id'));
const metaBefore = metaAt();
r = await patch({
  items: {
    set: [{ key: { order_item_id: 'i1' }, cols: { supplement: 'should not stick' } }],
    add: [{ order_item_id: 'i9', order_id: null, month: null, supplement: 'month is NOT NULL, so this fails' }],
  },
});
check('a failing statement fails the save (HTTP 502 with the reason)', r.status === 502 && /NOT NULL/i.test(r.body.error || ''), JSON.stringify(r));
check('…and the earlier statements in it are undone', JSON.stringify(q('SELECT * FROM order_items ORDER BY order_item_id')) === snapshot);
check('…and the change timestamp is not moved by a save that did not happen', metaAt() === metaBefore);
check('…nothing is left open (the next save works)', (await patch({ items: { set: [{ key: { order_item_id: 'i1' }, cols: { supplement: 'Alpha 3' } }] } })).status === 200);

// ── the whole-board PUT (restore/admin) still works, with two Junes, and is atomic too ──
const full = {
  months: [{ month: 'Jun', year: 2026, position: 1, notes: '' }, { month: 'Jun', year: 2027, position: 2, notes: '' }],
  orders: [{ order_id: 'p1', month: 'Jun', year: 2026, merchant: 'M', position: 1, status: 'Staged', notes: '' }],
  items: [{ order_item_id: 'pi1', order_id: 'p1', month: 'Jun', year: 2026, block_position: 1, item_position: 1, supplement: 'Zed', price_per_bottle: 1, order_qty_bottles: 1, include_in_total: true, notes: '', untracked: false }],
};
let pr = await onRequestPut({ request: { json: async () => full }, env });
check('PUT replaces the whole board', pr.status === 200 && q('SELECT count(*) AS n FROM order_items')[0].n === 1 && q('SELECT count(*) AS n FROM order_months')[0].n === 2);
const dupMonth = { ...full, months: [{ month: 'Jun', year: 2026, position: 1 }, { month: 'Jun', year: 2026, position: 2 }] };
pr = await onRequestPut({ request: { json: async () => dupMonth }, env });
check('a PUT that fails part-way changes nothing', pr.status === 502 && q('SELECT count(*) AS n FROM order_items')[0].n === 1 && q('SELECT count(*) AS n FROM order_months')[0].n === 2, String(pr.status));

await t.close();
let fail = 0;
console.log('\n/api/orders PATCH (fake Turso)\n' + '-'.repeat(40));
for (const c of checks) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  -> ' + c.detail}`); if (!c.ok) fail++; }
console.log('-'.repeat(40)); console.log(`${checks.length - fail}/${checks.length} passed`);
process.exit(fail ? 1 : 0);
