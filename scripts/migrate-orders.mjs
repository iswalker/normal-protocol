/* migrate-orders.mjs — create the Orders domain tables in Turso and seed the
   demo board. Idempotent: drops + recreates the three tables, then inserts.

   Run:  node scripts/migrate-orders.mjs     (needs .dev.vars with TURSO_*)

   Model (staging only; stock/dose/run-out come from the Inventory sheet, joined
   by order_items.supplement -> Inventory "Name"):
     order_months  one row per month column (spent = already-invested $)
     orders        one row per shipment/merchant order within a month
     order_items   one row per card; order_id NULL = a "loose" card in the month
   Block ordering within a month uses a shared position scale: orders.position
   and order_items.block_position index the blocks; item_position orders cards
   inside a shipment. */
import { run, text, int, real } from './turso.mjs';

const months = [
  // month, year, position
  ['Jun', 2026, 1],
  ['Jul', 2026, 2],
  ['Aug', 2026, 3],
];

const orders = [
  // order_id, month, merchant, position, status
  ['ord_bluesky_jun', 'Jun', 'Blue Sky Vitamin', 1, 'Staged'],
  ['ord_cellcore',    'Jun', 'CellCore Direct',  3, 'Staged'],
  ['ord_fullscript',  'Jul', 'Fullscript',       1, 'Staged'],
  ['ord_bluesky_aug', 'Aug', 'Blue Sky Vitamin', 1, 'Staged'],
];

const items = [
  // id, order_id(null=loose), month, block_pos, item_pos, supplement, price, qty, include
  ['oi_atp',       'ord_bluesky_jun', 'Jun', 1, 1, 'ATP',                63, 1, 1],
  ['oi_drainage',  'ord_bluesky_jun', 'Jun', 1, 2, 'Drainage Activator', 45, 1, 1],
  ['oi_para2',     'ord_bluesky_jun', 'Jun', 1, 3, 'Para 2',             40, 1, 1],
  ['oi_serratia',  'ord_bluesky_jun', 'Jun', 1, 4, 'Serratia',           54, 1, 0],
  ['oi_lymph',     null,              'Jun', 2, 1, 'LymphActiv',          36, 1, 1],
  ['oi_biotoxin1', 'ord_cellcore',    'Jun', 3, 1, 'BioToxin',           48, 1, 1],
  ['oi_biotoxin2', 'ord_cellcore',    'Jun', 3, 2, 'BioToxin',           48, 1, 1],
  ['oi_para1',     'ord_fullscript',  'Jul', 1, 1, 'Para 1',             42, 1, 0],
  ['oi_brain',     'ord_fullscript',  'Jul', 1, 2, 'Brain',              58, 1, 1],
  ['oi_thymus',    'ord_bluesky_aug', 'Aug', 1, 1, 'Thymus',             39, 1, 1],
];

const ddl = [
  'DROP TABLE IF EXISTS order_items',
  'DROP TABLE IF EXISTS orders',
  'DROP TABLE IF EXISTS order_months',
  `CREATE TABLE order_months (
     month    TEXT PRIMARY KEY,
     year     INTEGER,
     position INTEGER
   )`,
  `CREATE TABLE orders (
     order_id TEXT PRIMARY KEY,
     month    TEXT NOT NULL,
     merchant TEXT,
     position INTEGER,
     status   TEXT,
     notes    TEXT
   )`,
  `CREATE TABLE order_items (
     order_item_id     TEXT PRIMARY KEY,
     order_id          TEXT,
     month             TEXT NOT NULL,
     block_position    INTEGER,
     item_position     INTEGER,
     supplement        TEXT,
     price_per_bottle  REAL DEFAULT 0,
     order_qty_bottles REAL DEFAULT 0,
     include_in_total  INTEGER DEFAULT 1,
     notes             TEXT,
     untracked         INTEGER DEFAULT 0
   )`,
];

const inserts = [
  ...months.map(([m, y, p]) => ({
    sql: 'INSERT INTO order_months (month, year, position) VALUES (?, ?, ?)',
    args: [text(m), int(y), int(p)],
  })),
  ...orders.map(([id, m, mer, p, st]) => ({
    sql: 'INSERT INTO orders (order_id, month, merchant, position, status) VALUES (?, ?, ?, ?, ?)',
    args: [text(id), text(m), text(mer), int(p), text(st)],
  })),
  ...items.map(([id, oid, m, bp, ip, sup, pr, q, inc]) => ({
    sql: `INSERT INTO order_items
            (order_item_id, order_id, month, block_position, item_position, supplement, price_per_bottle, order_qty_bottles, include_in_total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [text(id), oid == null ? { type: 'null' } : text(oid), text(m), int(bp), int(ip), text(sup), real(pr), real(q), int(inc)],
  })),
];

await run([...ddl, ...inserts]);

// report
const [m, o, it] = await run([
  'SELECT count(*) AS n FROM order_months',
  'SELECT count(*) AS n FROM orders',
  'SELECT count(*) AS n FROM order_items',
]);
console.log(`Seeded: ${m[0].n} months, ${o[0].n} orders, ${it[0].n} order_items.`);
