/* ───────────────────────────────────────────────────────────────────────
   data.js — seed data (from the spreadsheet) + calculation helpers
   Everything lives under window.SB

   Model notes
   ───────────
   • daily dose (caps/day) comes straight from the sheet.
   • bottle size = capsules per bottle.
   • ORDER QTY is measured in BOTTLES; ordering q bottles adds q × bottleSize
     capsules to on-hand and extends the runway from today.
   • PRICE is per BOTTLE → order cost = price × qty(bottles).
   ─────────────────────────────────────────────────────────────────────── */
(function () {
  const DAY = 86400000;

  // ── time ────────────────────────────────────────────────────────────
  function today() { return new Date(); }
  function parseDate(iso) { return new Date(iso + 'T00:00:00'); }
  function addDays(d, n) { return new Date(d.getTime() + n * DAY); }
  function daysBetween(a, b) { return (b - a) / DAY; }

  // ── per-card calculation ────────────────────────────────────────────
  function calc(c) {
    const dose = Number(c.dose) || 1;                  // caps/day (explicit)
    const bottle = Number(c.bottleSize) || 0;          // caps/bottle
    const t = today();
    const logged = parseDate(c.loggedOn);
    const elapsed = Math.max(0, daysBetween(logged, t));
    const onHand = c.amount - dose * elapsed;           // may be < 0 (overdue)

    const curDaysLeft = onHand / dose;                  // = amount/dose − elapsed
    const curRunOut = addDays(logged, c.amount / dose); // true original projection

    const qty = Number(c.qty) || 0;                     // BOTTLES
    const added = qty * bottle;                         // capsules added
    const newOnHand = onHand + added;
    const newDaysLeft = newOnHand / dose;
    const newRunOut = addDays(t, newDaysLeft);          // fresh stock as of today

    const price = Number(c.price) || 0;                 // per bottle
    const cost = price * qty;

    return {
      dose, bottle, onHand, curDaysLeft, curRunOut,
      qty, added, newOnHand, newDaysLeft, newRunOut, price, cost,
      hasOrder: qty > 0,
    };
  }

  // ── formatting ──────────────────────────────────────────────────────
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDate(d) {
    const now = today();
    const base = `${MON[d.getMonth()]} ${d.getDate()}`;
    return d.getFullYear() !== now.getFullYear()
      ? `${base}, ’${String(d.getFullYear()).slice(2)}` : base;
  }
  function fmtDateShort(d) {
    const now = today();
    const base = `${d.getMonth() + 1}/${d.getDate()}`;
    return d.getFullYear() !== now.getFullYear()
      ? `${base}/${String(d.getFullYear()).slice(2)}` : base;
  }
  function fmtMoney(n) {
    return '$' + (Number(n) || 0).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMoney0(n) {
    return '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  }
  function fmtUnits(n) {
    const r = Math.round(n);
    return r < 0 ? '0' : `${r}`;
  }

  function tier(days, threshold) {
    if (days <= 0) return 'out';
    if (days < threshold) return 'soon';
    return 'ok';
  }

  // ── seed (mirrors the attached spreadsheet; price/qty/spent are examples) ─
  const SEED = {
    cardData: {
      drainage:  { name: 'Drainage Activator', amount: 62,  dose: 6,  bottleSize: 120, loggedOn: '2026-06-04', price: 45, qty: 1, includeInMonthTotal: true },
      biotoxin1: { name: 'BioToxin',           amount: 53,  dose: 4,  bottleSize: 120, loggedOn: '2026-06-04', price: 48, qty: 1, includeInMonthTotal: true },
      atp:       { name: 'ATP',                amount: 110, dose: 11, bottleSize: 120, loggedOn: '2026-06-04', price: 63, qty: 1, includeInMonthTotal: true },
      para2:     { name: 'Para 2',             amount: 65,  dose: 8,  bottleSize: 120, loggedOn: '2026-06-04', price: 40, qty: 1, includeInMonthTotal: true },
      serratia:  { name: 'Serratia',           amount: 9,   dose: 1,  bottleSize: 180, loggedOn: '2026-06-04', price: 54, qty: 1, includeInMonthTotal: false },
      biotoxin2: { name: 'BioToxin',           amount: 66,  dose: 4,  bottleSize: 120, loggedOn: '2026-05-29', price: 48, qty: 1, includeInMonthTotal: true },
      lymph:     { name: 'LymphActiv',         amount: 40,  dose: 2,  bottleSize: 60,  loggedOn: '2026-06-04', price: 36, qty: 1, includeInMonthTotal: true },
      para1:     { name: 'Para 1',             amount: 151, dose: 4,  bottleSize: 120, loggedOn: '2026-06-04', price: 42, qty: 1, includeInMonthTotal: false },
      brain:     { name: 'Brain',              amount: 105, dose: 2,  bottleSize: 180, loggedOn: '2026-05-29', price: 58, qty: 1, includeInMonthTotal: true },
      thymus:    { name: 'Thymus',             amount: 249, dose: 3,  bottleSize: 180, loggedOn: '2026-05-29', price: 39, qty: 1, includeInMonthTotal: true },
    },
    shipmentData: {
      s_bluesky_jun: { name: 'Blue Sky Vitamin' },
      s_cellcore:    { name: 'CellCore Direct' },
      s_fullscript:  { name: 'Fullscript' },
      s_bluesky_aug: { name: 'Blue Sky Vitamin' },
    },
    structure: [
      {
        id: 'm_jun', name: 'June', sub: '2026', spent: 480,
        blocks: [
          { type: 'shipment', id: 's_bluesky_jun', cards: ['atp', 'drainage', 'para2', 'serratia'] },
          { type: 'card', id: 'lymph' },
          { type: 'shipment', id: 's_cellcore', cards: ['biotoxin1', 'biotoxin2'] },
        ],
      },
      {
        id: 'm_jul', name: 'July', sub: '2026', spent: 0,
        blocks: [
          { type: 'shipment', id: 's_fullscript', cards: ['para1', 'brain'] },
        ],
      },
      {
        id: 'm_aug', name: 'August', sub: '2026', spent: 0,
        blocks: [
          { type: 'shipment', id: 's_bluesky_aug', cards: ['thymus'] },
        ],
      },
    ],
  };

  window.SB = {
    DAY, today, parseDate, addDays, daysBetween,
    calc, fmtDate, fmtDateShort, fmtMoney, fmtMoney0, fmtUnits, tier,
    SEED,
  };
})();
