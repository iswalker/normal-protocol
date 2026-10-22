/* ───────────────────────────────────────────────────────────────────────
   verify-warnings.mjs — headless test for the per-month "Needs attention"
   panel (Autoship approvals + run-out warnings).

   Fully offline: serves the repo statically and mocks EVERY /api/* endpoint
   in-process (nothing reaches Turso -- dev:local shares the live database, so
   a test must never write to a real endpoint). Dates are all computed from
   "now", so the suite doesn't go stale.

   Run:  npm run verify:warnings
   ─────────────────────────────────────────────────────────────────────── */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' };

// ── dates ──
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date(); now.setHours(0, 0, 0, 0);
const plusDays = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
const monthAt = (off) => { const d = new Date(now.getFullYear(), now.getMonth() + off, 1); return { month: MON[d.getMonth()], year: d.getFullYear(), start: d }; };
const M0 = monthAt(0), M1 = monthAt(1), M2 = monthAt(2), M3 = monthAt(3);
const ym0 = `${M0.year}-${String(M0.start.getMonth() + 1).padStart(2, '0')}`;

const D_ALPHA = iso(plusDays(2));                                   // in the current window
const D_LATER = iso(plusDays(3));                                   // card sits in month+2, date is in the current window
const D_SHIP = iso(plusDays(1));
const D_APPROVED = iso(plusDays(2));
const D_STALE = iso(plusDays(2));
const D_DUP = iso(plusDays(1));
const D_NEXT_EARLY = iso(new Date(M1.start.getFullYear(), M1.start.getMonth(), 3));   // inside the current window's tail (first week of next month)
const D_NEXT_MID = iso(new Date(M1.start.getFullYear(), M1.start.getMonth(), 20));   // next month proper
const D_FAR = iso(new Date(M3.start.getFullYear(), M3.start.getMonth(), 20)); // well outside the current window
const D_LOCKED = iso(plusDays(2));
const D_OVERDUE = iso(plusDays(-3));                                // only meaningful in the current month's panel

// ── mock board ──
const card = (id, order_id, m, bp, ip, name, extra = {}) => ({
  order_item_id: id, order_id, month: m.month, year: m.year, block_position: bp, item_position: ip,
  supplement: name, price_per_bottle: 10, order_qty_bottles: 1, include_in_total: true, notes: null, ...extra,
});
const ORDERS_BODY = {
  months: [M0, M1, M2].map((m, i) => ({ month: m.month, year: m.year, position: i + 1 })),
  orders: [
    { order_id: 'o_a', month: M0.month, year: M0.year, merchant: 'Alpha Shop', position: 1, status: 'Staged', notes: null },
    { order_id: 'o_ship', month: M0.month, year: M0.year, merchant: 'Ship-level Co', position: 2, status: 'Staged', notes: null, autoship_next_date: D_SHIP },
    { order_id: 'o_locked', month: M0.month, year: M0.year, merchant: 'Locked Co', position: 3, status: 'Ordered', notes: null },
    // the same shipment-level autoship stored on later months' instances of one merchant
    { order_id: 'o_dup1', month: M1.month, year: M1.year, merchant: 'Dup Co', position: 5, status: 'Staged', notes: null, autoship_next_date: D_DUP },
    { order_id: 'o_dup2', month: M2.month, year: M2.year, merchant: 'Dup Co', position: 5, status: 'Staged', notes: null, autoship_next_date: D_DUP },
    // Launch Preemptively: next-month orders. o_pre's autoship date is BEFORE its month (auto-on); o_norm has none
    { order_id: 'o_pre', month: M1.month, year: M1.year, merchant: 'Pre Auto Co', position: 6, status: 'Staged', notes: null, autoship_next_date: iso(now) },
    { order_id: 'o_norm', month: M1.month, year: M1.year, merchant: 'Normal Co', position: 7, status: 'Staged', notes: null },
    // no autoship date of its own, but an ITEM in it carries one from before its month -> auto-on
    { order_id: 'o_cardpre', month: M1.month, year: M1.year, merchant: 'Item Date Co', position: 8, status: 'Staged', notes: null },
    { order_id: 'o_ghost', month: M0.month, year: M0.year, merchant: 'Ghost Shop', position: 4, status: 'Staged', notes: null },
  ],
  items: [
    card('oi_alpha', 'o_a', M0, 1, 1, 'Alpha', { autoship_next_date: D_ALPHA, autoship_link: 'https://example.com/alpha' }),
    card('oi_approved', 'o_a', M0, 1, 2, 'Approved One', { autoship_next_date: D_APPROVED, autoship_approved: D_APPROVED }),
    card('oi_stale', 'o_a', M0, 1, 3, 'Stale Approval', { autoship_next_date: D_STALE, autoship_approved: iso(plusDays(-40)) }),
    card('oi_overdue', 'o_a', M0, 1, 4, 'Overdue One', { autoship_next_date: D_OVERDUE }),
    card('oi_noqty', 'o_a', M0, 1, 5, 'No Qty', { autoship_next_date: D_ALPHA, order_qty_bottles: 0 }),
    card('oi_locked', 'o_locked', M0, 3, 1, 'Locked One', { autoship_next_date: D_LOCKED }),
    // placed in a later month, but its date is inside the CURRENT window
    card('oi_later', null, M2, 1, 1, 'Later Placement', { autoship_next_date: D_LATER }),
    // date outside the window -> never listed in the current month
    card('oi_far', null, M1, 1, 1, 'Far Date', { autoship_next_date: D_FAR }),
    // recurring root: its projected ghosts must never produce rows of their own
    card('oi_ghosty', 'o_ghost', M0, 4, 1, 'Ghosty', { autoship_next_date: D_ALPHA, recur: 1 }),
    // has an order this month -> not a run-out warning even though it runs out soon
    card('oi_early', 'o_pre', M1, 6, 1, 'Early'),
    card('oi_late', 'o_norm', M1, 7, 1, 'Late'),
    card('oi_cardpre', 'o_cardpre', M1, 8, 1, 'Card Pre', { autoship_next_date: iso(now) }),
    card('oi_nextearly', 'o_a', M0, 1, 6, 'Next Early', { autoship_next_date: D_NEXT_EARLY }),
    card('oi_nextmid', 'o_a', M0, 1, 7, 'Next Mid', { autoship_next_date: D_NEXT_MID }),
    card('oi_covered', null, M0, 5, 1, 'Covered', {}),
  ],
};
// run-outs landing in the first week of next month / mid next month (whole days from today, dose 1/day)
const daysTo = (d) => Math.round((d - now) / 86400000);
const NEXT_RUNNER_DAYS = daysTo(new Date(M1.start.getFullYear(), M1.start.getMonth(), 3));
const MID_RUNNER_DAYS = daysTo(new Date(M1.start.getFullYear(), M1.start.getMonth(), 20));
const INV_ITEMS = [
  { id: 7, name: 'Next Runner', bottle_size: 60, daily_dose: 1 },
  { id: 8, name: 'Mid Runner', bottle_size: 60, daily_dose: 1 },
  { id: 1, name: 'Runner', bottle_size: 60, daily_dose: 1 },
  { id: 2, name: 'Covered', bottle_size: 60, daily_dose: 1 },
  { id: 3, name: 'Plenty', bottle_size: 60, daily_dose: 1 },
  { id: 4, name: 'Alpha', bottle_size: 60, daily_dose: 1 },
  { id: 5, name: 'Early', bottle_size: 60, daily_dose: 1 },
  { id: 6, name: 'Late', bottle_size: 60, daily_dose: 1 },
];
const INV_LOG = [
  { id: 7, item: 'Next Runner', type: 'Reset', amount: NEXT_RUNNER_DAYS, logged_on: iso(now), order_id: null },
  { id: 8, item: 'Mid Runner', type: 'Reset', amount: MID_RUNNER_DAYS, logged_on: iso(now), order_id: null },
  { id: 1, item: 'Runner', type: 'Reset', amount: 2, logged_on: iso(now), order_id: null },
  { id: 2, item: 'Covered', type: 'Reset', amount: 2, logged_on: iso(now), order_id: null },
  { id: 3, item: 'Plenty', type: 'Reset', amount: 400, logged_on: iso(now), order_id: null },
  { id: 4, item: 'Alpha', type: 'Reset', amount: 400, logged_on: iso(now), order_id: null },
  { id: 5, item: 'Early', type: 'Reset', amount: 2, logged_on: iso(now), order_id: null },
  { id: 6, item: 'Late', type: 'Reset', amount: 2, logged_on: iso(now), order_id: null },
];

const dismissed = new Set();
const puts = [];      // /api/orders PUT bodies
const posts = [];     // /api/board-settings POST bodies

const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {};
      if (p === '/api/orders') {
        if (req.method === 'PUT') { puts.push(body); return json(res, { ok: true }); }
        return json(res, ORDERS_BODY);
      }
      if (p === '/api/board-settings') {
        if (req.method === 'POST') {
          posts.push(body);
          if (body.action === 'dismiss') dismissed.add(body.key);
          if (body.action === 'undismiss') dismissed.delete(body.key);
          return json(res, { ok: true, dismissedWarnings: [...dismissed] });
        }
        if (req.method === 'PUT') return json(res, { ok: true });
        return json(res, { pinnedMerchants: [], dismissedWarnings: [...dismissed] });
      }
      if (p === '/api/inventory-items') return json(res, INV_ITEMS);
      if (p === '/api/inventory') return json(res, INV_LOG);
      if (p === '/api/meta') return json(res, { updated_at: '2000-01-01T00:00:00.000Z' });
      return json(res, { error: 'stub' }, 502);
    }
    let fp = decodeURIComponent(p); if (fp === '/' || fp === '') fp = '/index.html';
    const file = normalize(join(ROOT, fp));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) { res.writeHead(e && e.code === 'ENOENT' ? 404 : 500); res.end('not found'); }
  }
});

const checks = [];
const check = (name, cond, detail = '') => checks.push({ name, ok: !!cond, detail });

await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const errors = [];

async function openBoard(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#tab-board #board .month');
  // inventory loads after boardReady -- wait for the run-out row it produces
  await page.waitForSelector('.month-warn .warn-row', { timeout: 10000 });
  return { ctx, page };
}

// the CURRENT month's panel
const panel = (page) => page.locator(`.month[data-id="${M0.month}_${M0.year}"] .month-warn`);
const rowNames = (page) => panel(page).locator('.warn-row .warn-name').allTextContents();
const rowFor = (page, name) => panel(page).locator('.warn-row', { has: page.locator('.warn-name', { hasText: new RegExp(`^${name}$`) }) });

try {
  const { ctx, page } = await openBoard({ width: 1700, height: 1000 });
  const names = await rowNames(page);
  // SHOT_DIR=<dir> saves screenshots of the panel for eyeballing
  if (process.env.SHOT_DIR) await page.locator(`.month[data-id="${M0.month}_${M0.year}"]`).screenshot({ path: join(process.env.SHOT_DIR, 'warn-desktop.png') });
  if (process.env.SHOT_DIR) {
    await page.locator(`.month[data-id="${M1.month}_${M1.year}"]`).screenshot({ path: join(process.env.SHOT_DIR, 'preempt-next-month.png') });
    await page.locator('header').screenshot({ path: join(process.env.SHOT_DIR, 'header-desktop.png') });
  }

  // ── which rows exist ──
  check('listed: unapproved autoship in the current month', names.includes('Alpha'), names.join(', '));
  check('listed: autoship whose card is placed in a LATER month', names.includes('Later Placement'));
  check('listed: shipment-level autoship', names.includes('Ship-level Co'));
  check('listed: unapproved because stored approval is for a different date', names.includes('Stale Approval'));
  check('listed: overdue autoship (current month only)', names.includes('Overdue One'));
  check('not listed: already-approved autoship', !names.includes('Approved One'));
  check('not listed: autoship with no quantity ordered', !names.includes('No Qty'));
  check('not listed: autoship in an Ordered shipment', !names.includes('Locked One'));
  check('not listed: autoship dated outside the window', !names.includes('Far Date'));
  check('recurring root listed exactly once (ghosts excluded)', names.filter((n) => n === 'Ghosty').length === 1, String(names.filter((n) => n === 'Ghosty').length));
  check('run-out: item running out with no order this month', names.includes('Runner'));
  check('run-out: not listed when an order exists this month', !names.includes('Covered'));
  check('run-out: not listed when plenty on hand', !names.includes('Plenty'));
  check('heading reads "Needs Attention"', (await panel(page).locator('.warn-head').textContent()).trim().startsWith('Needs Attention'));
  const detailOf = async (n) => (await rowFor(page, n).locator('.warn-detail').textContent()).replace(/\s+/g, ' ').trim();
  check('autoship row text: "<item> autoships <date> ..."', /^autoships \d+\/\d+/.test(await detailOf('Alpha')), await detailOf('Alpha'));
  check('run-out row text: "<item> runs out <date> ..."', /^runs out \d+\/\d+/.test(await detailOf('Runner')), await detailOf('Runner'));
  check('no label pills left', (await panel(page).locator('.warn-tag').count()) === 0);
  check('item name comes first in the row', await rowFor(page, 'Runner').locator('.warn-main').evaluate((e) => e.firstElementChild.classList.contains('warn-name')));
  const later = await rowFor(page, 'Later Placement').locator('.warn-detail').textContent();
  check('later-placed row says which month it sits in', later.includes(M2.month), later);
  check('overdue row is flagged', /overdue/.test(await rowFor(page, 'Overdue One').locator('.warn-detail').textContent()));
  check('panel shows a count badge', (await panel(page).locator('.warn-count').textContent()).trim() === String(names.length), String(names.length));
  // past months get no panel; the panel lives outside .month-list
  check('panel is outside .month-list', (await page.locator('.month-list .month-warn').count()) === 0);

  // ── Launch Preemptively ──
  const pbtn = (id) => page.locator(`.shipment[data-id="${id}"] > .ship-head > .ship-preempt`);
  const lastOrder = (id) => puts[puts.length - 1]?.orders.find((o) => o.order_id === id);
  check('preemptive: an order whose autoship date is before its month is ON automatically', (await pbtn('o_pre').getAttribute('class')).includes('is-on'));
  check('preemptive: ON automatically when an ITEM in it has an autoship date from before its month', (await pbtn('o_cardpre').getAttribute('class')).includes('is-on'));
  check('preemptive: an ordinary order is off', !(await pbtn('o_norm').getAttribute('class')).includes('is-on'));
  check('needs-attention: item in a preemptive next-month order counts as ordered now', !names.includes('Early'));
  check('needs-attention: item in an ordinary next-month order still warns', names.includes('Late'));
  await pbtn('o_norm').click(); await page.waitForTimeout(700);
  check('preemptive: manually turning one on suppresses its item warning', !(await rowNames(page)).includes('Late'));
  check('preemptive: a manual ON is stored as 1', lastOrder('o_norm')?.preemptive === 1, JSON.stringify(lastOrder('o_norm')));
  check('preemptive: the automatic one is stored as automatic (null)', lastOrder('o_pre')?.preemptive == null, JSON.stringify(lastOrder('o_pre')?.preemptive));
  await pbtn('o_pre').click(); await page.waitForTimeout(700);
  check('preemptive: manually turning an automatic one OFF is stored as 0 and the warning returns', lastOrder('o_pre')?.preemptive === 0 && (await rowNames(page)).includes('Early'), JSON.stringify(lastOrder('o_pre')?.preemptive));
  await pbtn('o_pre').click(); await page.waitForTimeout(700);
  check('preemptive: turning it back on returns to automatic (null)', lastOrder('o_pre')?.preemptive == null && !(await rowNames(page)).includes('Early'));
  // header filter
  const visibleShips = () => page.evaluate((m) => [...document.querySelectorAll(`.month[data-id="${m}"] .month-list > .shipment:not(.search-hide) .ship-name`)].map((e) => e.textContent), `${M1.month}_${M1.year}`);
  await page.locator('#inv-preempt-btn').click();
  const filtered = await visibleShips();
  check('filter: Preemptive button is active and shows only preemptive orders', (await page.locator('#inv-preempt-btn').getAttribute('class')).includes('active') && ['Pre Auto Co', 'Normal Co', 'Dup Co'].every((n) => filtered.includes(n)), filtered.join(', '));
  await pbtn('o_norm').click(); await page.waitForTimeout(500); // back to automatic/off
  check('filter: un-flagged order drops out of the filtered view', !(await visibleShips()).includes('Normal Co'));
  await page.locator('#inv-autoship-btn').click();
  check('filter: Autoship and Preemptive are mutually exclusive', !(await page.locator('#inv-preempt-btn').getAttribute('class')).includes('active'));
  await page.locator('#inv-autoship-btn').click();
  check('filter: turning filters off restores the board', (await visibleShips()).includes('Normal Co'));

  // ── preemptive mirrors in the PREVIOUS month ──
  const m0list = page.locator(`.month[data-id="${M0.month}_${M0.year}"] .month-list`);
  const mirrorNames = () => m0list.locator('.month-preempt .pre-name').allTextContents();
  const mnames = await mirrorNames();
  check('mirror: a preemptive next-month order appears in this month', mnames.includes('Pre Auto Co') && mnames.includes('Dup Co') && mnames.includes('Item Date Co'), mnames.join(', '));
  check('mirror: an ordinary next-month order does not', !mnames.includes('Normal Co'));
  check('mirror: sits at the bottom of the open orders (just above the completed ones)', await m0list.evaluate((l) => { const w = l.querySelector(':scope > .month-preempt'); return !!w && w.nextElementSibling && w.nextElementSibling.classList.contains('is-locked') && !w.previousElementSibling.classList.contains('is-locked'); }));
  check('mirror: greyed read-only block, not a shipment/card', await m0list.evaluate((l) => { const m = l.querySelector('.pre-ship'); return !m.classList.contains('shipment') && !m.querySelector('.card, [data-id], input, [contenteditable]'); }));
  const plannedBefore = await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .plannedv`).textContent();
  const countBefore = await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .mcount`).textContent();
  await pbtn('o_norm').click(); await page.waitForTimeout(700); // flag one more order -> one more mirror
  check('mirror: flagging another order adds its mirror', (await mirrorNames()).includes('Normal Co'));
  check('mirror: does not change the month metrics or count', (await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .plannedv`).textContent()) === plannedBefore && (await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .mcount`).textContent()) === countBefore);
  const savedOrders = puts[puts.length - 1].orders.map((o) => o.order_id);
  check('mirror: never saved (no duplicate or extra orders)', new Set(savedOrders).size === savedOrders.length && savedOrders.length === (await page.locator('.shipment').count()), `${savedOrders.length} vs ${await page.locator('.shipment').count()}`);
  await page.locator('.pre-ship', { hasText: 'Normal Co' }).click();
  await page.waitForTimeout(250);
  check('mirror: clicking it jumps to the real order', await page.locator('.shipment[data-id="o_norm"]').evaluate((e) => e.classList.contains('warn-flash')));
  await pbtn('o_norm').click(); await page.waitForTimeout(700); // back to off
  check('mirror: turning the flag off removes it', !(await mirrorNames()).includes('Normal Co'));
  await page.locator('#inv-preempt-btn').click();
  check('mirror: hidden while a filter is active', (await m0list.locator('.month-preempt').count()) === 0);
  await page.locator('#inv-preempt-btn').click();

  const m1Panel = await page.locator(`.month[data-id="${M1.month}_${M1.year}"] .month-warn .warn-name`).allTextContents();
  // ── links: name -> Inventory, order month -> the order ──
  await rowFor(page, 'Runner').locator('.warn-name').click();
  await page.waitForTimeout(300);
  check('item name opens Inventory filtered to that item', (await page.locator('#inv-filter-item').inputValue()) === 'Runner' && await page.locator('#tab-inventory').isVisible());
  await page.locator('#inv-modal-close').click();
  await page.waitForTimeout(200);
  await rowFor(page, 'Later Placement').locator('.warn-month').first().click();
  await page.waitForTimeout(250);
  check('order month jumps to (and highlights) that order', await page.locator('.card[data-id="oi_later"]').evaluate((e) => e.classList.contains('warn-flash')));
  const lateNext = rowFor(page, 'Late').locator('.warn-month');
  check('run-out row offers its next order month', (await lateNext.count()) === 1 && (await lateNext.textContent()).trim() === M1.month);
  await lateNext.click();
  await page.waitForTimeout(250);
  check('next-order month jumps to that card', await page.locator('.card[data-id="oi_late"]').evaluate((e) => e.classList.contains('warn-flash')));
  check('item with no later card has no next-order link', (await rowFor(page, 'Runner').locator('.warn-month').count()) === 0);
  check('shipment-level row name is plain text (no Inventory link)', (await rowFor(page, 'Ship-level Co').locator('.warn-name[data-act]').count()) === 0);

  const dates = await panel(page).locator('.warn-row').evaluateAll((els) => els.map((e) => e.dataset.wdate));
  check('rows are ordered by date, soonest first', dates.length > 3 && dates.every((d, i) => i === 0 || dates[i - 1] <= d), dates.join(' '));
  check('Autoship and Runs-out rows are interlaced, not grouped', names.indexOf('Runner') < names.indexOf('Later Placement') && names.indexOf('Runner') > names.indexOf('Overdue One'), names.join(', '));
  check('panel has no warning icon', (await panel(page).locator('.warn-head svg').count()) === 0);
  const boxBg = await panel(page).locator('.warn-box').evaluate((e) => getComputedStyle(e).backgroundColor);
  const shipBg = await page.locator('.shipment').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  check('panel background matches a shipment', boxBg === shipBg, `${boxBg} vs ${shipBg}`);
  check('one-month rule: a 3rd-of-next-month autoship shows in the CURRENT month', names.includes('Next Early'));
  check('one-month rule: …and NOT again in the next month', !m1Panel.includes('Next Early'), m1Panel.join(', '));
  check('one-month rule (run-outs): an item running out the 3rd of next month shows in the CURRENT month', names.includes('Next Runner'), names.join(', '));
  check('one-month rule (run-outs): …and NOT again in the next month', !m1Panel.includes('Next Runner'), m1Panel.join(', '));
  check('one-month rule (run-outs): a mid-next-month run-out is only in the next month', !names.includes('Mid Runner') && m1Panel.includes('Mid Runner'), m1Panel.join(', '));
  check('one-month rule: a mid-next-month autoship is only in the next month', !names.includes('Next Mid') && m1Panel.includes('Next Mid'), m1Panel.join(', '));
  check('duplicate autoship across months collapses to one row', names.filter((n) => n === 'Dup Co').length === 1, String(names.filter((n) => n === 'Dup Co').length));
  const dupDetail = await rowFor(page, 'Dup Co').locator('.warn-detail').textContent();
  check('collapsed row names every month it sits in', dupDetail.includes(M1.month) && dupDetail.includes(M2.month), dupDetail);
  await rowFor(page, 'Dup Co').locator('[data-act="warn-approve"]').click();
  await page.waitForTimeout(700);
  check('approving the collapsed row approves every copy', ['o_dup1', 'o_dup2'].every((id) => puts[puts.length - 1]?.orders.find((o) => o.order_id === id)?.autoship_approved === D_DUP), JSON.stringify(puts[puts.length - 1]?.orders.map((o) => [o.order_id, o.autoship_approved])));
  check('…and none of them resurfaces', !(await rowNames(page)).includes('Dup Co'));
  names.splice(names.indexOf('Dup Co'), 1);

  // ── dates: m/d like the board, clickable when there's a link ──
  const alphaRow = rowFor(page, 'Alpha');
  const dateTxt = (await alphaRow.locator('.warn-date').textContent()).trim();
  const boardTxt = (await page.locator('.card[data-id="oi_alpha"] .autoship-date, .card[data-id="oi_alpha"] .autoship-date-badge').locator('visible=true').first().textContent()).trim();
  check('panel date matches the board card date format', dateTxt === boardTxt && /^\d+\/\d+/.test(dateTxt), `${dateTxt} vs ${boardTxt}`);
  check('run-out date also uses m/d', /runs out \d+\/\d+/.test(await rowFor(page, 'Runner').locator('.warn-detail').textContent()));
  check('date without a link is not a link', (await rowFor(page, 'Stale Approval').locator('.warn-date.has-link').count()) === 0 && (await rowFor(page, 'Stale Approval').locator('.warn-date').count()) === 1);
  await ctx.route('https://example.com/**', (r) => r.fulfill({ body: 'ok', contentType: 'text/html' }));
  const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 5000 }).catch(() => null), alphaRow.locator('.warn-date').click()]);
  check('clicking the date opens the Autoship link', popup && popup.url().startsWith('https://example.com/alpha'), popup ? popup.url() : 'no popup');
  await popup?.close();

  // ── run-out Ignore / restore ──
  await rowFor(page, 'Runner').locator('[data-act="warn-ignore"]').click();
  await page.waitForTimeout(150);
  check('Ignore removes the run-out row', !(await rowNames(page)).includes('Runner'));
  check('Ignore posts a dismiss with a month-scoped key', posts.some((b) => b.action === 'dismiss' && b.key === `runout|runner|${ym0}`), JSON.stringify(posts));
  const chip = panel(page).locator('.warn-head .warn-ign');
  check('"n ignored" chip sits in the panel header (top right), not at the bottom', /1 ignored/.test(await chip.textContent()) && await chip.evaluate((c) => { const h = c.closest('.warn-head').getBoundingClientRect(), r = c.getBoundingClientRect(); return r.right > h.right - 40 && r.top < h.top + 30; }));
  check('no restore link at the bottom of the list any more', (await panel(page).locator('.warn-foot, .warn-restore').count()) === 0);
  await chip.hover();
  await page.waitForSelector('.warn-ign-pop .wip-row', { state: 'visible' });
  check('hovering the chip previews the ignored item (name + run-out date)', /Runner/.test(await page.locator('.warn-ign-pop').textContent()) && /runs out \d+\/\d+/.test(await page.locator('.warn-ign-pop .wip-detail').first().textContent()));
  await page.locator('.warn-ign-pop .wip-btn[data-wip="one"]').first().click();
  await page.waitForTimeout(250);
  check('the popover closes itself once nothing is left ignored', !(await page.locator('.warn-ign-pop').isVisible()));
  check('Restore brings the row back', (await rowNames(page)).includes('Runner'));
  check('Restore posts an undismiss', posts.some((b) => b.action === 'undismiss' && b.key === `runout|runner|${ym0}`));
  // …and a reload keeps an ignore (server-side state), but only for THIS month's key
  await rowFor(page, 'Runner').locator('[data-act="warn-ignore"]').click();
  await page.waitForTimeout(150);
  await page.reload();
  await page.waitForSelector('#tab-board #board .month');
  await page.waitForFunction(() => window._INV_ITEM_MAP && document.querySelector('.month-warn .warn-row'), null, { timeout: 10000 });
  await page.waitForTimeout(500);
  check('ignore survives a reload', !(await rowNames(page)).includes('Runner'));
  await panel(page).locator('.warn-ign').hover(); // leave the mock clean
  await page.locator('.warn-ign-pop .wip-btn[data-wip="one"]').first().click();
  await page.waitForTimeout(250);
  await page.mouse.move(5, 5); await page.waitForTimeout(400);

  // ── several ignored: per-item restore and Restore all ──
  for (const n of ['Runner', 'Late']) { await rowFor(page, n).locator('[data-act="warn-ignore"]').click(); await page.waitForTimeout(120); }
  await panel(page).locator('.warn-ign').hover();
  await page.waitForSelector('.warn-ign-pop .wip-row', { state: 'visible' });
  const popNames = await page.locator('.warn-ign-pop .wip-name').allTextContents();
  if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'ign-pop.png'), clip: { x: 0, y: 0, width: 900, height: 560 } });
  check('popover lists every ignored item', popNames.includes('Runner') && popNames.includes('Late'), popNames.join(', '));
  await page.locator('.warn-ign-pop .wip-row', { hasText: 'Late' }).locator('.wip-btn').click();
  await page.waitForTimeout(250);
  check('restoring one leaves the others ignored (popover stays open for them)', (await rowNames(page)).includes('Late') && !(await rowNames(page)).includes('Runner') && await page.locator('.warn-ign-pop').isVisible());
  await rowFor(page, 'Late').locator('[data-act="warn-ignore"]').click(); await page.waitForTimeout(150);
  await panel(page).locator('.warn-ign').hover();
  await page.waitForSelector('.warn-ign-pop [data-wip="all"]');
  await page.locator('.warn-ign-pop [data-wip="all"]').click();
  await page.waitForTimeout(300);
  check('Restore all brings every ignored item back', (await rowNames(page)).includes('Runner') && (await rowNames(page)).includes('Late') && (await panel(page).locator('.warn-ign').count()) === 0);
  await page.mouse.move(5, 5); await page.waitForTimeout(400);

  // ── hover the panel's date: same calendar + approve as every other autoship date ──
  await rowFor(page, 'Later Placement').locator('.warn-date').hover();
  await page.waitForSelector('.autoship-cal .autoship-cal-approve-btn');
  check('panel date hover opens the calendar, selected on its date', (await page.locator('.autoship-cal-day.is-selected').getAttribute('data-iso')) === D_LATER);
  await page.locator('.autoship-cal-approve-btn').click();
  await page.waitForTimeout(500);
  check('approving from the panel date hover removes the row', !(await rowNames(page)).includes('Later Placement'));
  check('…and persists the approval on the underlying card', puts[puts.length - 1]?.items.find((i) => i.order_item_id === 'oi_later')?.autoship_approved === D_LATER);
  await page.mouse.move(5, 5); await page.waitForTimeout(400);
  // picking a new date from the panel changes the record itself
  await rowFor(page, 'Stale Approval').locator('.warn-date').hover();
  await page.waitForSelector('.autoship-cal');
  await page.locator('.autoship-cal-day[data-iso]:not(.is-selected)').first().click();
  await page.waitForTimeout(500);
  check('picking a date in the panel hover saves it', puts[puts.length - 1]?.items.find((i) => i.order_item_id === 'oi_stale')?.autoship_next_date !== D_STALE);
  await page.mouse.move(5, 5); await page.waitForTimeout(400);
  await page.evaluate(({ id, d }) => window.SupplementBoard.saveCardAutoship(id, '', d), { id: 'oi_stale', d: D_STALE }); // restore for later steps
  await page.waitForTimeout(200);

  // ── Approve from the panel ──
  const before = (await rowNames(page)).length;
  await rowFor(page, 'Alpha').locator('[data-act="warn-approve"]').click();
  await page.waitForTimeout(200);
  check('Approve removes the autoship row', !(await rowNames(page)).includes('Alpha') && (await rowNames(page)).length === before - 1);
  const alphaDate = page.locator('.card[data-id="oi_alpha"] .autoship-date, .card[data-id="oi_alpha"] .autoship-date-badge').locator('visible=true').first();
  const teal = await alphaDate.evaluate((el) => getComputedStyle(el).color);
  const tealRef = await page.evaluate(() => { const e = document.createElement('span'); e.style.color = '#3f8f87'; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; });
  check('approved date turns teal (the +#m accent colour)', teal === tealRef, `${teal} vs ${tealRef}`);
  const pendingDate = page.locator('.card[data-id="oi_stale"] .autoship-date, .card[data-id="oi_stale"] .autoship-date-badge').locator('visible=true').first();
  const orange = await pendingDate.evaluate((el) => getComputedStyle(el).color);
  check('pending date stays orange', orange !== tealRef, orange);
  await page.waitForTimeout(600);
  const lastPut = puts[puts.length - 1];
  const savedAlpha = lastPut?.items.find((i) => i.order_item_id === 'oi_alpha');
  check('approval persisted to /api/orders as the approved DATE', savedAlpha?.autoship_approved === D_ALPHA, JSON.stringify(savedAlpha?.autoship_approved));
  check('approved row of a different card untouched', lastPut?.items.find((i) => i.order_item_id === 'oi_stale')?.autoship_approved !== D_STALE);

  // ── hover panel: approve / undo ──
  await pendingDate.hover();
  await page.waitForSelector('.autoship-cal .autoship-cal-approve-btn');
  if (process.env.SHOT_DIR) await page.locator('.autoship-cal').screenshot({ path: join(process.env.SHOT_DIR, 'popout.png') });
  check('popout footer: Today is above Approve', await page.evaluate(() => { const t = document.querySelector('.autoship-cal-today-btn').getBoundingClientRect(), a = document.querySelector('.autoship-cal-approve-btn').getBoundingClientRect(); return t.bottom <= a.top + 1; }));
  check('hover panel offers "Approve"', (await page.locator('.autoship-cal-approve-btn').textContent()).trim() === 'Approve');
  await page.locator('.autoship-cal-approve-btn').click();
  await page.waitForTimeout(200);
  check('hover-panel approve removes the panel row', !(await rowNames(page)).includes('Stale Approval'));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await alphaDate.hover();
  await page.waitForSelector('.autoship-cal .autoship-cal-approve-btn.is-approved');
  check('hover panel shows "Approved"', (await page.locator('.autoship-cal-approve-btn').textContent()).trim() === 'Approved');
  await page.locator('.autoship-cal-approve-btn').click();
  await page.waitForTimeout(200);
  check('hover-panel undo brings the row back', (await rowNames(page)).includes('Alpha'));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);

  // ── popout modal ──
  await page.evaluate(({ id, d }) => window.InventoryWriter.openAutoshipModal({ id, name: 'Overdue One', link: '', nextDate: d, approved: false }), { id: 'oi_overdue', d: D_OVERDUE });
  check('modal: approve checkbox enabled when a date is set', await page.locator('#autoship-approved').isEnabled());
  await page.locator('#autoship-approved').check();
  await page.locator('#autoship-save-btn').click();
  await page.waitForTimeout(200);
  check('modal approve removes the panel row', !(await rowNames(page)).includes('Overdue One'));
  await page.evaluate(({ id, d }) => window.InventoryWriter.openAutoshipModal({ id, name: 'Overdue One', link: '', nextDate: d, approved: true }), { id: 'oi_overdue', d: D_OVERDUE });
  check('modal reopens with the box ticked', await page.locator('#autoship-approved').isChecked());
  // change the date -> the box un-ticks itself (an approval is per-date)
  await page.locator('#autoship-date-trigger').click();
  await page.locator('.autoship-cal-day[data-iso]:not(.is-selected)').first().click();
  check('modal: picking a different date un-ticks approval', !(await page.locator('#autoship-approved').isChecked()));
  await page.locator('#autoship-save-btn').click();
  await page.waitForTimeout(200);
  await page.waitForTimeout(500);
  check('saving a moved date stores no approval for it',
    puts[puts.length - 1]?.items.find((i) => i.order_item_id === 'oi_overdue')?.autoship_approved == null,
    JSON.stringify(puts[puts.length - 1]?.items.find((i) => i.order_item_id === 'oi_overdue')));

  // ── editing the date alone drops the approval ──
  await page.evaluate((d) => window.SupplementBoard.saveCardAutoship('oi_approved', '', d), iso(plusDays(3)));
  await page.waitForTimeout(200);
  check('editing an approved date lapses its approval', (await rowNames(page)).includes('Approved One'));

  // ── lifecycle: approve a recurring root, complete it, next date needs a FRESH approval ──
  await page.evaluate(() => window.SupplementBoard.setAutoshipApproved('card', 'oi_ghosty', true));
  await page.waitForTimeout(150);
  check('lifecycle: approved recurring root leaves the panel', !(await rowNames(page)).includes('Ghosty'));
  // the stage buttons are zero-size at this width (the Status dropdown replaces them), but both drive the same delegated 'set-stage' handler
  await page.evaluate(() => document.querySelector('.shipment[data-id="o_ghost"] [data-act="set-stage"][data-stage="ordered"]').click());
  await page.waitForTimeout(900);
  const gItems = puts[puts.length - 1].items.filter((i) => i.supplement === 'Ghosty');
  const newRoot = gItems.find((i) => !i.recur_source);
  const oldRoot = gItems.find((i) => i.recur_source);
  const nextD = new Date(now); nextD.setDate(nextD.getDate() + 2); nextD.setMonth(nextD.getMonth() + 1);
  check('lifecycle: next occurrence promoted to root with the advanced date', newRoot && newRoot.autoship_next_date === iso(nextD), JSON.stringify(newRoot));
  check('lifecycle: the advanced date is NOT pre-approved', newRoot && newRoot.autoship_approved == null, JSON.stringify(newRoot?.autoship_approved));
  const m1Names = await page.locator(`.month[data-id="${M1.month}_${M1.year}"] .month-warn .warn-name`).allTextContents();
  const m0Again = await rowNames(page);
  check('lifecycle: the fresh approval is asked for in exactly one month', m0Again.filter((n) => n === 'Ghosty').length + m1Names.filter((n) => n === 'Ghosty').length === 1, `${m0Again.join(',')} | ${m1Names.join(',')}`);
  check('lifecycle: pre-advance projected ghosts never produced rows before', oldRoot && oldRoot.autoship_approved === iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2)));

  // ── grip menus open BESIDE the grip, never over it (it's the drag handle too) ──
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  async function menuVsGrip(gripSel, how, anchorBottom) {
    const grip = page.locator(gripSel).first();
    await grip.evaluate((g, bottom) => g.scrollIntoView({ block: bottom ? 'end' : 'center', inline: 'center' }), anchorBottom);
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    if (how === 'hover') { await grip.hover(); await page.waitForSelector('.ship-ctx-menu', { timeout: 3000 }); await page.waitForTimeout(150); }
    else { await grip.click(); await page.waitForSelector('.ship-ctx-menu'); await page.waitForTimeout(150); }
    const res = await page.evaluate((sel) => {
      const g = document.querySelector(sel).getBoundingClientRect(), m = document.querySelector('.ship-ctx-menu').getBoundingClientRect();
      const cx = g.left + g.width / 2, cy = g.top + g.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return { g: { left: g.left, right: g.right, top: g.top, bottom: g.bottom }, m: { left: m.left, right: m.right, top: m.top, bottom: m.bottom }, gripOnTop: !!hit && !!hit.closest('.card-grip, .ship-grip'), inView: m.top >= 0 && m.bottom <= innerHeight && m.left >= 0 && m.right <= innerWidth };
    }, gripSel);
    await page.mouse.move(5, 5); await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    return res;
  }
  for (const [label, sel] of [['card grip', '.card[data-id="oi_alpha"] .card-grip'], ['shipment grip', '.shipment[data-id="o_a"] .ship-grip']]) {
    for (const how of ['hover', 'click']) {
      for (const bottom of [false, true]) {
        const r = await menuVsGrip(sel, how, bottom);
        check(`menu ${how}-opened from a ${label}${bottom ? ' near the bottom of the screen' : ''} does not cover the grip`, !overlaps(r.m, r.g) && r.gripOnTop && r.inView, JSON.stringify(r));
      }
    }
  }

  // ── at 0 left to act on, the whole panel goes away ──
  for (let i = 0; i < 40; i++) {
    const b = panel(page).locator('[data-act="warn-approve"], [data-act="warn-ignore"]').first();
    if (!(await b.count())) break;
    await b.click(); await page.waitForTimeout(80);
  }
  check('with 0 items left the entire panel is hidden', await panel(page).evaluate((e) => e.hidden && e.innerHTML.trim() === ''));
  dismissed.clear(); // the mock server's ignore list, so the mobile pass below starts clean

  // ── nothing leaks into past/other structure ──
  check('no JS errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // ── mobile: panel renders and Approve is tappable ──
  const m = await openBoard({ width: 390, height: 800 });
  if (process.env.SHOT_DIR) await m.page.screenshot({ path: join(process.env.SHOT_DIR, 'warn-mobile.png') });
  if (process.env.SHOT_DIR) await m.page.locator('header').screenshot({ path: join(process.env.SHOT_DIR, 'header-mobile.png') });
  const boxW = () => m.page.locator('.global-search-box').evaluate((e) => e.getBoundingClientRect().width);
  const restW = await boxW();
  await m.page.locator('#global-search-input').focus();
  await m.page.waitForTimeout(200);
  check('mobile: focusing search gives it the room (header buttons step aside)', (await boxW()) > Math.max(restW + 100, 180), `${restW} -> ${await boxW()}`);
  await m.page.locator('#global-search-input').blur();
  if (process.env.SHOT_DIR) await m.page.locator(`.month[data-id="${M1.month}_${M1.year}"]`).screenshot({ path: join(process.env.SHOT_DIR, 'preempt-mobile.png') });
  // mobile: ignore one, tap the chip -> the popover fits the screen and Restore works
  await m.page.locator(`.month[data-id="${M0.month}_${M0.year}"] .month-warn [data-act="warn-ignore"]`).first().click();
  await m.page.waitForTimeout(200);
  const mChip = m.page.locator(`.month[data-id="${M0.month}_${M0.year}"] .warn-ign`);
  await mChip.click();
  await m.page.waitForSelector('.warn-ign-pop .wip-row', { state: 'visible' });
  const popBox = await m.page.locator('.warn-ign-pop').boundingBox();
  check('mobile: tapping the chip opens the ignored list, within the screen', popBox && popBox.x >= 0 && popBox.x + popBox.width <= 390 && popBox.y >= 0, JSON.stringify(popBox));
  if (process.env.SHOT_DIR) await m.page.screenshot({ path: join(process.env.SHOT_DIR, 'ign-pop-mobile.png') });
  await m.page.locator('.warn-ign-pop .wip-btn').first().click();
  await m.page.waitForTimeout(250);
  check('mobile: Restore works and the chip goes away', (await mChip.count()) === 0 && !(await m.page.locator('.warn-ign-pop').isVisible()));
  check('mobile: panel renders', (await m.page.locator('.month-warn:not([hidden]) .warn-row').count()) > 0);
  const mBtn = m.page.locator(`.month[data-id="${M0.month}_${M0.year}"] .month-warn [data-act="warn-approve"]`).first();
  const mBox = await mBtn.boundingBox();
  check('mobile: Approve button within viewport width', mBox && mBox.x >= 0 && mBox.x + mBox.width <= 390, JSON.stringify(mBox));
  check('mobile: no horizontal overflow from the panel', await m.page.evaluate(() => document.getElementById('tab-board').scrollWidth <= document.getElementById('tab-board').clientWidth + 1));
  await m.ctx.close();
} catch (e) {
  checks.push({ name: 'test run completed', ok: false, detail: String(e && e.stack || e) });
} finally {
  await browser.close();
  server.close();
}

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : '  →  ' + c.detail}`);
  if (!c.ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
