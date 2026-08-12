/**
 * One-time migration: reads items.json in the project root and upserts
 * all rows into Turso inventory_items.
 *
 * 1. Open the app in your browser, connect Google Sheets so the Inventory
 *    tab shows items.
 * 2. In the browser console, run:
 *      copy(JSON.stringify(Object.values(window._INV_ITEM_MAP||{}).filter(x=>x.name).map((x,i)=>({name:x.name,bottle_size:x.bottleSize||0,daily_dose:x.dose||0,annual_sale:x.annualSale||'',off_cycle_sale:x.offCycleSale||'',anyday:x.anyday||'',barcode:x.barcode||'',sort_order:i}))))
 * 3. Paste the clipboard into a file called  items.json  at the repo root.
 * 4. Run:  npm run import-items
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './turso.mjs';

const root  = join(fileURLToPath(import.meta.url), '..', '..');
const items = JSON.parse(await readFile(join(root, 'items.json'), 'utf8'));

if (!Array.isArray(items) || !items.length) {
  console.error('items.json is empty or not a JSON array.');
  process.exit(1);
}

const UPSERT = `
  INSERT INTO inventory_items (name,bottle_size,daily_dose,annual_sale,off_cycle_sale,anyday,barcode,sort_order)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(name) DO UPDATE SET
    bottle_size=excluded.bottle_size, daily_dose=excluded.daily_dose,
    annual_sale=excluded.annual_sale, off_cycle_sale=excluded.off_cycle_sale,
    anyday=excluded.anyday, barcode=excluded.barcode, sort_order=excluded.sort_order`;

const stmts = items.map((item, i) => ({
  sql: UPSERT,
  args: [
    { type: 'text',    value: String(item.name) },
    { type: 'float',   value: Number(item.bottle_size)   || 0 },
    { type: 'float',   value: Number(item.daily_dose)    || 0 },
    { type: 'text',    value: String(item.annual_sale    ?? '') },
    { type: 'text',    value: String(item.off_cycle_sale ?? '') },
    { type: 'text',    value: String(item.anyday         ?? '') },
    { type: 'text',    value: String(item.barcode        ?? '') },
    { type: 'integer', value: String(item.sort_order     ?? i)  },
  ],
}));

await run(stmts);

const rows = await run([{ sql: 'SELECT COUNT(*) as n FROM inventory_items' }]);
console.log(`Done. inventory_items now has ${rows[0][0].n} rows.`);
