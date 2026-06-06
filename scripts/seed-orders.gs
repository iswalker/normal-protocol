/* ───────────────────────────────────────────────────────────────────────
   seed-orders.gs — one-time seeder for the Supplement Ordering board.

   HOW TO RUN
   1. Open the spreadsheet → Extensions → Apps Script.
   2. Paste this whole file, Save, pick `seedOrders`, click Run, authorize.
   3. It creates/overwrites two tabs: "Orders" and "Order Months", and fills
      them with the demo board data (Jun/Jul/Aug).

   DATA MODEL (staging only — stock / dose / run-out live in the Inventory tab)
   ───────────────────────────────────────────────────────────────────────────
   "Orders" tab = one row per ORDER ITEM (a card on the board). An ORDER (a
   merchant shipment) is reconstructed by grouping rows that share order_id; a
   blank order_id means a "loose" card sitting directly in the month.
     order_item_id      stable id for the line
     month              Jun | Jul | Aug   (matches Order Months.month)
     order_id           shipment id, or blank for a loose card
     merchant           shipment display name, or blank for a loose card
     supplement         item name — JOIN KEY to Inventory "Name" at runtime
     price_per_bottle   staged price per bottle ($)
     order_qty_bottles  bottles to order
     include_in_total   TRUE/FALSE — counts toward the month's Planned total
     order_position     order of the shipment/loose block within the month
     item_position      order of the item within its shipment
     status             staging status (Staged | Sent | Received)
     notes              free text

   "Order Months" tab = month-level metadata (the board's column headers)
     month | year | spent (already-invested $) | position
   ─────────────────────────────────────────────────────────────────────────── */

function seedOrders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var monthsHeader = ['month', 'year', 'spent', 'position'];
  var monthsRows = [
    ['Jun', 2026, 480, 1],
    ['Jul', 2026, 0, 2],
    ['Aug', 2026, 0, 3],
  ];

  var ordersHeader = [
    'order_item_id', 'month', 'order_id', 'merchant', 'supplement',
    'price_per_bottle', 'order_qty_bottles', 'include_in_total',
    'order_position', 'item_position', 'status', 'notes',
  ];
  // month, order_id, merchant, supplement, price, qty, include, orderPos, itemPos
  var ordersRows = [
    ['oi_atp',       'Jun', 'ord_bluesky_jun', 'Blue Sky Vitamin', 'ATP',                63, 1, true,  1, 1, 'Staged', ''],
    ['oi_drainage',  'Jun', 'ord_bluesky_jun', 'Blue Sky Vitamin', 'Drainage Activator', 45, 1, true,  1, 2, 'Staged', ''],
    ['oi_para2',     'Jun', 'ord_bluesky_jun', 'Blue Sky Vitamin', 'Para 2',             40, 1, true,  1, 3, 'Staged', ''],
    ['oi_serratia',  'Jun', 'ord_bluesky_jun', 'Blue Sky Vitamin', 'Serratia',           54, 1, false, 1, 4, 'Staged', ''],
    ['oi_lymph',     'Jun', '',                '',                 'LymphActiv',          36, 1, true,  2, 1, 'Staged', 'loose card'],
    ['oi_biotoxin1', 'Jun', 'ord_cellcore',    'CellCore Direct',  'BioToxin',           48, 1, true,  3, 1, 'Staged', ''],
    ['oi_biotoxin2', 'Jun', 'ord_cellcore',    'CellCore Direct',  'BioToxin',           48, 1, true,  3, 2, 'Staged', ''],
    ['oi_para1',     'Jul', 'ord_fullscript',  'Fullscript',       'Para 1',             42, 1, false, 1, 1, 'Staged', ''],
    ['oi_brain',     'Jul', 'ord_fullscript',  'Fullscript',       'Brain',              58, 1, true,  1, 2, 'Staged', ''],
    ['oi_thymus',    'Aug', 'ord_bluesky_aug', 'Blue Sky Vitamin', 'Thymus',             39, 1, true,  1, 1, 'Staged', ''],
  ];

  writeSheet_(ss, 'Order Months', monthsHeader, monthsRows);
  writeSheet_(ss, 'Orders', ordersHeader, ordersRows);

  SpreadsheetApp.getUi().alert('Seeded "Orders" (' + ordersRows.length +
    ' items) and "Order Months" (' + monthsRows.length + ' months).');
}

/** Create the sheet if missing, clear it, write header + rows, freeze + bold header. */
function writeSheet_(ss, name, header, rows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var all = [header].concat(rows);
  sh.getRange(1, 1, all.length, header.length).setValues(all);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, header.length);
}
