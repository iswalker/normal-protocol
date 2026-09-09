import { run } from './turso.mjs';

// Adds the two columns the "Add/Edit Autoship Link" card context-menu action
// needs. Nullable, no default -- existing rows just get NULL, same as every
// other optional inventory_items column (bottle_size, barcode, etc.).
await run([
  { sql: 'ALTER TABLE inventory_items ADD COLUMN autoship_link TEXT' },
  { sql: 'ALTER TABLE inventory_items ADD COLUMN autoship_next_date TEXT' },
]);

console.log('inventory_items.autoship_link / autoship_next_date added.');
