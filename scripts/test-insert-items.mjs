import { run } from './turso.mjs';

try {
  await run([{
    sql: `INSERT INTO inventory_items (name, bottle_size, daily_dose, annual_sale, off_cycle_sale, anyday, barcode, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      { type: 'text', value: 'Test Item' },
      { type: 'float', value: 90 },
      { type: 'float', value: 2 },
      { type: 'text', value: 'Amazon' },
      { type: 'text', value: '' },
      { type: 'text', value: '' },
      { type: 'text', value: '' },
      { type: 'integer', value: '0' },
    ],
  }]);
  console.log('INSERT OK');
  const rows = await run([{ sql: 'SELECT id, name, bottle_size, daily_dose FROM inventory_items' }]);
  console.log('Rows:', JSON.stringify(rows[0]));
  await run([{ sql: "DELETE FROM inventory_items WHERE name='Test Item'" }]);
  console.log('Cleanup done');
} catch (e) {
  console.error('ERROR:', e.message);
}
