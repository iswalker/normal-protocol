/* board-model.mjs — for the offline test servers: applies a PATCH /api/orders
   body to an in-memory { months, orders, items } the way functions/api/orders.js
   applies it to the database (delete, add-or-replace, update named columns), so
   a test can look at "the board as the server now holds it" after each save. */

const TABLES = {
  months: ['month', 'year'],
  orders: ['order_id'],
  items: ['order_item_id'],
};
const same = (keys, row, key) => keys.every((k) => (row[k] ?? null) === (key[k] ?? null));

export function applyPatch(model, patch) {
  for (const [name, keys] of Object.entries(TABLES)) {
    const part = patch && patch[name];
    if (!part) continue;
    const rows = (model[name] = model[name] || []);
    for (const key of part.del || []) {
      const i = rows.findIndex((r) => same(keys, r, key));
      if (i >= 0) rows.splice(i, 1);
    }
    for (const row of part.add || []) {
      const i = rows.findIndex((r) => same(keys, r, row));
      if (i >= 0) rows[i] = { ...row }; else rows.push({ ...row });
    }
    for (const e of part.set || []) {
      const r = rows.find((x) => same(keys, x, e.key));
      if (r) Object.assign(r, e.cols);
    }
  }
  return model;
}

export const clone = (o) => JSON.parse(JSON.stringify(o));
