import { run } from './turso.mjs';

await run([{
  sql: `CREATE TABLE IF NOT EXISTS inventory_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    bottle_size   REAL,
    daily_dose    REAL,
    annual_sale   TEXT,
    off_cycle_sale TEXT,
    anyday        TEXT,
    barcode       TEXT,
    sort_order    INTEGER DEFAULT 0
  )`,
}]);

console.log('inventory_items table ready.');
