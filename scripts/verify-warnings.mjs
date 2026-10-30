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
const P1 = monthAt(-1), P2 = monthAt(-2); // empty PAST months (should never be shown)
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
  months: [P2, P1, M0, M1, M2].map((m, i) => ({ month: m.month, year: m.year, position: i + 1 })),
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
    // a preemptive order in the month AFTER M1 (so M1 gets a "from next month" preview group), and a completed one in M1
    { order_id: 'o_pre2', month: M2.month, year: M2.year, merchant: 'Pre Two Co', position: 9, status: 'Staged', notes: null, autoship_next_date: iso(now) },
    { order_id: 'o_lock1', month: M1.month, year: M1.year, merchant: 'Locked Nov', position: 9, status: 'Ordered', notes: null },
    // every item an approved autoship -> shows the "Approved" status (its date is mid-M1, so it isn't preemptive)
    { order_id: 'o_appr', month: M1.month, year: M1.year, merchant: 'Approved Co', position: 10, status: 'Staged', notes: null },
    // a 1-item order whose item has NO autoship date of its own, but the ORDER's autoship date is approved
    { order_id: 'o_appr2', month: M1.month, year: M1.year, merchant: 'Order-Level Approved Co', position: 11, status: 'Staged', notes: null, autoship_next_date: D_NEXT_MID, autoship_approved: D_NEXT_MID },
    // a 1-item order whose item is an approved autoship but whose ORDER-level date is still pending
    { order_id: 'o_appr3', month: M1.month, year: M1.year, merchant: 'Pending Order Date Co', position: 12, status: 'Staged', notes: null, autoship_next_date: D_NEXT_MID },
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
    card('oi_pre2', 'o_pre2', M2, 9, 1, 'Pre2 Item'),
    card('oi_lock1', 'o_lock1', M1, 9, 1, 'Locked Nov Item'),
    card('oi_appr', 'o_appr', M1, 10, 1, 'Appr Item', { autoship_next_date: D_NEXT_MID, autoship_approved: D_NEXT_MID }),
    card('oi_gap', 'o_a', M0, 1, 8, 'Gap Item', { autoship_next_date: iso(plusDays(5)) }),
    card('oi_plain2', 'o_appr2', M1, 11, 1, 'Plain Item Two'),
    card('oi_appr3', 'o_appr3', M1, 12, 1, 'Appr Item Three', { autoship_next_date: D_NEXT_MID, autoship_approved: D_NEXT_MID }),
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
  { id: 9, name: 'Gap Item', bottle_size: 60, daily_dose: 1 },
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
  // runs out in 2 days -- but its autoship (below) doesn't ship for 5: it runs out FIRST
  { id: 9, item: 'Gap Item', type: 'Reset', amount: 2, logged_on: iso(now), order_id: null },
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
  await page.waitForSelector('#tab-board #board .month', { state: 'attached' });
  // inventory loads after boardReady -- wait for the run-out row it produces
  await page.waitForSelector('.month-warn .warn-row', { timeout: 10000 });
  return { ctx, page };
}

// the CURRENT month's panel
// the Needs Attention title label (a sibling just above the box, not inside it)
const panelHead = (page) => page.locator(`.month[data-id="${M0.month}_${M0.year}"] .month-warn-head`);
const panel = (page) => page.locator(`.month[data-id="${M0.month}_${M0.year}"] .month-warn`);
const rowNames = (page) => panel(page).locator('.warn-row .warn-name').allTextContents();
const rowFor = (page, name) => panel(page).locator('.warn-row', { has: page.locator('.warn-name', { hasText: new RegExp(`^${name}$`) }) });
// is the element's top edge just below its month's sticky header (rather than hidden under it)?
const clearOfHead = (page, sel) => page.evaluate((q) => { const el = document.querySelector(q); const head = el.closest('.month').querySelector(':scope > .month-head'); const t = el.getBoundingClientRect().top, hb = head.getBoundingClientRect().bottom; return { ok: t >= hb - 1 && t <= hb + 80, t, hb }; }, sel);

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
  const hiddenPast = await page.evaluate((ids) => ids.map((id) => { const e = document.querySelector('.month[data-id="' + id + '"]'); return !e || getComputedStyle(e).display === 'none'; }), [P2.month + '_' + P2.year, P1.month + '_' + P1.year]);
  check('empty PAST months stay hidden (the panel/headers inside a list don\'t count as content)', hiddenPast.every(Boolean), JSON.stringify(hiddenPast));
  check('heading reads "Needs Attention"', (await panelHead(page).textContent()).trim().startsWith('Needs Attention'));
  const detailOf = async (n) => (await rowFor(page, n).locator('.warn-detail').textContent()).replace(/\s+/g, ' ').trim();
  check('autoship row text: "<item> autoships <date> ..."', /^autoships \d+\/\d+/.test(await detailOf('Alpha')), await detailOf('Alpha'));
  check('run-out row text: "<item> runs out <date> ..."', /^runs out \d+\/\d+/.test(await detailOf('Runner')), await detailOf('Runner'));
  // the item's run-out sits beside the autoship date, to compare the two
  if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'ro-rows.png'), clip: { x: 0, y: 100, width: 760, height: 460 } });
  check('autoship row shows the item\'s run-out next to the autoship date', /^autoships \d+\/\d+ · runs out \d+\/\d+/.test(await detailOf('Alpha')), await detailOf('Alpha'));
  check('a run-out later than the autoship is not flagged', (await rowFor(page, 'Alpha').locator('.warn-ro.is-gap').count()) === 0 && (await rowFor(page, 'Alpha').locator('.warn-ro').count()) === 1);
  check('a run-out BEFORE the autoship ships is flagged red', (await rowFor(page, 'Gap Item').locator('.warn-ro.is-gap').count()) === 1 && /runs out/.test(await rowFor(page, 'Gap Item').locator('.warn-ro').textContent()));
  check('items with no Inventory data show no run-out', !/runs out/.test(await detailOf('Stale Approval')) && !/runs out/.test(await detailOf('Ship-level Co')));
  check('no label pills left', (await panel(page).locator('.warn-tag').count()) === 0);
  check('item name comes first in the row', await rowFor(page, 'Runner').locator('.warn-main').evaluate((e) => e.firstElementChild.classList.contains('warn-name')));
  const later = await rowFor(page, 'Later Placement').locator('.warn-detail').textContent();
  check('later-placed row says which month it sits in', later.includes(M2.month), later);
  check('overdue row is flagged', /overdue/.test(await rowFor(page, 'Overdue One').locator('.warn-detail').textContent()));
  check('no count badge next to the Needs Attention title', (await panelHead(page).locator('.warn-count').count()) === 0 && !/\d\s*$/.test((await panelHead(page).evaluate((h) => h.firstChild.textContent)).trim()));
  // past months get no panel; the panel lives outside .month-list
  check('panel is a (non-order) child of the month list, so Preemptive orders can sit above it', (await page.locator('.month-list > .month-warn.month-aux').count()) > 0 && (await page.locator('.month > .month-warn').count()) === 0);

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
  check('the header "Preemptive" filter button is gone', (await page.locator('#inv-preempt-btn').count()) === 0);
  await pbtn('o_norm').click(); await page.waitForTimeout(500); // back to automatic/off
  await page.locator('#inv-autoship-btn').click();
  await page.locator('#inv-autoship-btn').click();
  check('filter: turning filters off restores the board', (await visibleShips()).includes('Normal Co'));

  // ── preemptive mirrors in the PREVIOUS month ──
  const m0list = page.locator(`.month[data-id="${M0.month}_${M0.year}"] > .month-list`);
  const mirrorNames = () => m0list.locator('.month-preempt > .pre-host').evaluateAll((els) => els.map((e) => e.shadowRoot.querySelector('.ship-name')?.textContent.trim()));
  const mnames = await mirrorNames();
  check('mirror: a preemptive next-month order appears in this month', mnames.includes('Pre Auto Co') && mnames.includes('Dup Co') && mnames.includes('Item Date Co'), mnames.join(', '));
  check('mirror: an ordinary next-month order does not', !mnames.includes('Normal Co'));
  check('mirror: sits at the bottom of the open orders (just above the completed ones)', await m0list.evaluate((l) => { const w = l.querySelector(':scope > .month-preempt'); const h = w && w.nextElementSibling; return !!w && !!h && h.classList.contains('month-done-head') && h.nextElementSibling.classList.contains('is-locked') && !w.previousElementSibling.classList.contains('is-locked'); }));
  check('mirror: invisible to the board (document-wide .shipment/.card/data-id queries never see it)', await page.evaluate(() => {
    const host = document.querySelector('.pre-host'); const root = host.shadowRoot;
    return !!root.querySelector('.shipment') && !host.querySelector('.shipment, .card') && ![...document.querySelectorAll('.shipment, .card')].some((e) => e.closest('.month-preempt'));
  }));
  // the FULL order structure: same header + every item with its fields, same colours as the real order, expanded
  const full = await page.evaluate(() => {
    const host = [...document.querySelectorAll('.pre-host')].find((h) => h.shadowRoot.querySelector('.ship-name')?.textContent.trim() === 'Pre Auto Co');
    const sh = host.shadowRoot.querySelector('.shipment');
    const real = [...document.querySelectorAll('.shipment')].find((e) => e.querySelector('.ship-name')?.textContent === 'Pre Auto Co');
    const body = sh.querySelector('.ship-body');
    const names = (el) => [...el.querySelectorAll('.card-name')].map((n) => n.textContent.trim());
    const vals = (el) => [...el.querySelectorAll('.ship-body input')].map((i) => i.value);
    return {
      standardColour: !sh.classList.contains('is-locked') && getComputedStyle(sh).backgroundColor === getComputedStyle(real).backgroundColor, expanded: !sh.classList.contains('is-collapsed') && body.getBoundingClientRect().height > 20,
      hasHead: !!sh.querySelector('.ship-head .ship-name') && !!sh.querySelector('.ship-total'), preemptBtn: !!sh.querySelector('.ship-preempt.is-on'),
      sameItems: JSON.stringify(names(sh)) === JSON.stringify(names(real)) && names(sh).length > 0,
      sameFields: JSON.stringify(vals(sh)) === JSON.stringify(vals(real)) && vals(sh).length > 0,
      fields: !!sh.querySelector('.card .proj') && !!sh.querySelector('.card .order') && !!sh.querySelector('.card .card-foot'),
      editable: sh.querySelectorAll('.ship-body input').length > 0 && [...sh.querySelectorAll('.ship-body input')].every((i) => !i.disabled),
      sameTotal: sh.querySelector('.ship-total .amt').textContent === real.querySelector('.ship-total .amt').textContent,
    };
  });
  if (process.env.SHOT_DIR) {
    await page.evaluate(() => document.querySelector('.month-preempt').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(process.env.SHOT_DIR, 'mirror-full.png') });
  }
  // colour scheme: grey = contains an Autoship item, teal = none; previews follow it too
  const GREY = 'rgb(243, 244, 244)', TEAL = 'rgb(234, 246, 244)';
  const bgOf = (sel) => page.evaluate((q) => getComputedStyle(document.querySelector(q)).backgroundColor, sel);
  const mirrorBg = (name) => page.evaluate((n) => getComputedStyle([...document.querySelectorAll('.pre-host')].find((h) => h.shadowRoot.querySelector('.ship-name')?.textContent.trim() === n).shadowRoot.querySelector('.shipment')).backgroundColor, name);
  check('colour: an order containing an Autoship item is grey', (await bgOf('.shipment[data-id="o_a"]')) === GREY, await bgOf('.shipment[data-id="o_a"]'));
  check('colour: an order with a shipment-level autoship is grey', (await bgOf('.shipment[data-id="o_ship"]')) === GREY);
  check('colour: an order with no Autoship is the standard teal', (await bgOf('.shipment[data-id="o_norm"]')) === TEAL, await bgOf('.shipment[data-id="o_norm"]'));
  check('colour: a preemptive preview of an autoship order is grey too', (await mirrorBg('Pre Auto Co')) === GREY && (await mirrorBg('Item Date Co')) === GREY);
  // completed-orders header
  const doneHead = await page.evaluate((id) => {
    const list = document.querySelector('.month[data-id="' + id + '"] > .month-list');
    const h = list.querySelector(':scope > .month-done-head');
    return { text: h && h.textContent, before: !!h && h.nextElementSibling && h.nextElementSibling.classList.contains('is-locked'), after: !!h && !h.previousElementSibling.classList.contains('is-locked') };
  }, M0.month + '_' + M0.year);
  check('completed header: "Completed Orders" sits right above the first completed order', doneHead.text === 'Completed Orders' && doneHead.before && doneHead.after, JSON.stringify(doneHead));
  check('completed header: a month with no completed orders has none', (await page.locator('.month[data-id="' + M2.month + '_' + M2.year + '"] > .month-list > .month-done-head').count()) === 0);
  // ── the sandwich: Preemptive / Needs Attention / In-Month / Preemptive-from-next / Completed ──
  const m1id = M1.month + '_' + M1.year;
  const seq = await page.evaluate((id) => [...document.querySelectorAll('.month[data-id="' + id + '"] > .month-list > *')].map((n) => {
    const c = n.classList;
    if (c.contains('month-pre-head')) return 'pre-head';
    if (c.contains('month-warn-head')) return 'warn-head';
    if (c.contains('month-warn')) return 'warn';
    if (c.contains('month-in-head')) return 'in-head';
    if (c.contains('month-mirror-head')) return 'mirror-head';
    if (c.contains('month-preempt')) return 'mirrors';
    if (c.contains('month-done-head')) return 'done-head';
    if (c.contains('month-appr-head')) return 'appr-head';
    if (c.contains('shipment')) return c.contains('is-locked') ? 'locked' : c.contains('is-approved') ? 'approved' : (n.querySelector(':scope > .ship-head > .ship-preempt.is-on') ? 'pre' : 'std');
    return 'other';
  }), m1id);
  check('month layout: Preemptive / Needs Attention / In-Month / Preemptive-from-next / Completed', /^pre-head( pre)+ warn-head warn in-head( (std|other))+ mirror-head mirrors appr-head( approved)+ done-head( locked)+$/.test(seq.join(' ')), seq.join(' '));
  const heads = await page.evaluate((id) => Object.fromEntries(['pre-head', 'in-head', 'mirror-head', 'done-head'].map((k) => [k, document.querySelector('.month[data-id="' + id + '"] > .month-list > .month-' + k.replace('-head', '') + (k === 'mirror-head' ? '-head' : '-head'))?.textContent])), m1id);
  check('section headers read Preemptive Orders / In-Month Orders / Preemptive Orders · <next month> / Completed Orders', heads['pre-head'] === 'Preemptive Orders' && heads['in-head'] === 'In-Month Orders' && heads['mirror-head'] === 'Preemptive Orders · ' + M2.month && heads['done-head'] === 'Completed Orders', JSON.stringify(heads));
  check('the panel really is below the Preemptive group and above In-Month', seq.indexOf('warn') > seq.lastIndexOf('pre') && seq.indexOf('warn') < seq.indexOf('in-head'));
  // ── the "Approved" status: every item an approved autoship ──
  const apprSel = '.shipment[data-id="o_appr"]';
  const apprInfo = () => page.evaluate((sel) => {
    const sh = document.querySelector(sel), body = sh.querySelector(':scope > .ship-body');
    return { approved: sh.classList.contains('is-approved'), locked: sh.classList.contains('is-locked'), label: sh.querySelector(':scope > .ship-head > .ship-stage-select').textContent.trim(), bodyHidden: getComputedStyle(body).display === 'none' };
  }, apprSel);
  const m1Planned = () => page.locator('.month[data-id="' + m1id + '"] .plannedv').textContent();
  const a0 = await apprInfo();
  check('Approved: an order whose items are all approved autoships reads "Approved", collapsed -- and is NOT locked', a0.approved && !a0.locked && a0.label === 'Approved' && a0.bodyHidden, JSON.stringify(a0));
  const isAppr = (id) => page.evaluate((i) => document.querySelector('.shipment[data-id="' + i + '"]').classList.contains('is-approved'), id);
  check('Approved: a 1-item order whose own (order-level) autoship date is approved becomes Approved', await isAppr('o_appr2'));
  check('Approved: a 1-item order whose item is an approved autoship becomes Approved even with its order-level date still pending', await isAppr('o_appr3'));
  check('Approved: …and that pending order-level date still has its own row in Needs Attention', (await page.locator('.month[data-id="' + m1id + '"] .month-warn .warn-name', { hasText: 'Pending Order Date Co' }).count()) === 1);
  check('Approved: it has its own "Approved Orders" header above Completed', (await page.locator('.month[data-id="' + m1id + '"] > .month-list > .month-appr-head').textContent()) === 'Approved Orders');
  check('Approved: an order with items that are NOT all approved autoships is not Approved', !(await page.evaluate(() => document.querySelector('.shipment[data-id="o_a"]').classList.contains('is-approved'))) && !(await page.evaluate(() => document.querySelector('.shipment[data-id="o_norm"]').classList.contains('is-approved'))));
  const planned0 = await m1Planned();
  // revoke one approval -> pulled straight back out to blank
  await page.evaluate(() => window.SupplementBoard.setAutoshipApproved('card', 'oi_appr', false));
  await page.waitForTimeout(300);
  const a1 = await apprInfo();
  check('Approved: revoking the approval pulls the order back out (status blank, expanded)', !a1.approved && a1.label === 'Status' && !a1.bodyHidden, JSON.stringify(a1));
  check('Approved: back among the In-Month orders (not in the Approved group)', await page.evaluate(() => { const sh = document.querySelector('.shipment[data-id="o_appr"]'); let n = sh.previousElementSibling; while (n && !n.classList.contains('month-sec-head')) n = n.previousElementSibling; return !!n && n.classList.contains('month-in-head'); }));
  check('Approved: neither state changes the month\'s Planned figure (it is not placed yet)', (await m1Planned()) === planned0, planned0 + ' vs ' + await m1Planned());
  // status dropdown: approve the whole order from its Status menu...
  const stageBtn = (sel) => page.locator(sel + ' > .ship-head > .ship-stage-select');
  // the Status menu opens on hover (desktop) -- a click on top of that would just close it again
  const openStatus = async (sel) => { await page.keyboard.press('Escape'); await page.mouse.move(5, 5); await page.waitForTimeout(350); await stageBtn(sel).hover(); await page.waitForSelector('.ship-ctx-menu .ship-ctx-item'); };
  const menuItems = () => page.evaluate(() => [...document.querySelectorAll('.ship-ctx-menu .ship-ctx-item')].map((e) => ({ t: e.textContent, active: e.classList.contains('ctx-active'), disabled: e.classList.contains('ctx-disabled') })));
  await openStatus(apprSel);
  await page.waitForSelector('.ship-ctx-menu .ship-ctx-item');
  const mi = await menuItems();
  check('Status menu lists Approved first after clear, before Ordered', mi.map((x) => x.t).join('|') === 'Status (clear)|Approved|Ordered|Entered|Received', mi.map((x) => x.t).join('|'));
  check('…and "Approved" is enabled (every item has an autoship date)', !mi.find((x) => x.t === 'Approved').disabled);
  await page.locator('.ship-ctx-menu .ship-ctx-item', { hasText: /^Approved$/ }).click();
  await page.waitForTimeout(400);
  check('picking Approved in the Status menu approves every item and the order flips to Approved', (await apprInfo()).approved && (await apprInfo()).label === 'Approved');
  check('Approved stays "Staged" in storage (derived, never written as a status)', puts[puts.length - 1]?.orders.find((o) => o.order_id === 'o_appr')?.status === 'Staged');
  // ...and "Status (clear)" while Approved revokes it
  await openStatus(apprSel);
  await page.waitForSelector('.ship-ctx-menu .ship-ctx-item');
  check('while Approved the menu shows Approved as the active status', (await menuItems()).find((x) => x.t === 'Approved').active);
  await page.locator('.ship-ctx-menu .ship-ctx-item', { hasText: /^Status \(clear\)$/ }).click();
  await page.waitForTimeout(400);
  check('"Status (clear)" while Approved revokes the approvals (back to blank)', !(await apprInfo()).approved);
  await page.evaluate(() => window.SupplementBoard.setAutoshipApproved('card', 'oi_appr', true)); // fixture back to Approved
  await page.waitForTimeout(250);
  // an order whose items aren't all autoships can't be approved from the menu
  await openStatus('.shipment[data-id="o_norm"]');
  await page.waitForSelector('.ship-ctx-menu .ship-ctx-item');
  check('an order with non-autoship items has "Approved" disabled in its Status menu', (await menuItems()).find((x) => x.t === 'Approved').disabled);
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5); await page.waitForTimeout(300);

  // grouping rules: order WITHIN a group sticks; an order dropped in the wrong group snaps back
  const unlockedOrder = () => page.evaluate((id) => [...document.querySelectorAll('.month[data-id="' + id + '"] > .month-list > .shipment:not(.is-locked)')].map((sh) => sh.querySelector('.ship-name').textContent + (sh.querySelector(':scope > .ship-head > .ship-preempt.is-on') ? '*' : '')), m1id);
  const orderBefore = await unlockedOrder();
  const preNames = orderBefore.filter((n) => n.endsWith('*')).map((n) => n.slice(0, -1));
  await page.evaluate(({ id, a, b }) => {
    const list = document.querySelector('.month[data-id="' + id + '"] > .month-list');
    const byName = (n) => [...list.querySelectorAll(':scope > .shipment')].find((sh) => sh.querySelector('.ship-name').textContent === n);
    list.insertBefore(byName(b), byName(a));            // swap two Preemptive orders (a drag within their group)
    list.insertBefore(byName('Normal Co'), byName(a));  // and drop an in-month order up into that group
    window.SupplementBoard.recalc();
  }, { id: m1id, a: preNames[0], b: preNames[1] });
  const after = await unlockedOrder();
  const afterPre = after.filter((n) => n.endsWith('*')).map((n) => n.slice(0, -1));
  check('dragging a Preemptive order within its group sticks', afterPre[0] === preNames[1] && afterPre[1] === preNames[0], afterPre.join(', '));
  check('an in-month order dropped among the Preemptive ones snaps back below them', after.indexOf('Normal Co') > after.lastIndexOf(preNames[0] + '*'), after.join(', '));
  check('Preemptive orders are all grouped at the top of their own month', after.slice(0, afterPre.length).every((n) => n.endsWith('*')), after.join(', '));

  // a REAL pointer drag (Sortable's fallback) within the Preemptive group
  await page.evaluate((id) => document.querySelector('.month[data-id="' + id + '"] > .month-list > .month-pre-head').scrollIntoView({ block: 'start' }), m1id);
  await page.waitForTimeout(300);
  const preList = async () => (await unlockedOrder()).filter((n) => n.endsWith('*')).map((n) => n.slice(0, -1));
  const p0 = await preList();
  const gripOf = (name) => page.locator('.month[data-id="' + m1id + '"] > .month-list > .shipment', { has: page.locator('.ship-name', { hasText: new RegExp('^' + name + '$') }) }).first();
  const gb = await gripOf(p0[p0.length - 1]).locator(':scope > .ship-head > .ship-grip').boundingBox();
  const tb = await gripOf(p0[0]).locator(':scope > .ship-head').boundingBox();
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) { await page.mouse.move(gb.x + gb.width / 2, gb.y + (tb.y + 4 - gb.y) * i / 14, { steps: 2 }); await page.waitForTimeout(25); }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const p1 = await preList();
  check('a real drag reorders orders within the Preemptive group (and they stay grouped)', p1[0] === p0[p0.length - 1] && p1.length === p0.length, p0.join(',') + ' -> ' + p1.join(','));
  if (process.env.SHOT_DIR) {
    await page.evaluate((id) => document.querySelector('.month[data-id="' + id + '"]').scrollIntoView({ block: 'start', inline: 'start' }), m1id);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(process.env.SHOT_DIR, 'sandwich.png') });
  }

  check('mirror: shows the real order\'s full structure (header, every item, every field), expanded and editable', Object.values(full).every(Boolean), JSON.stringify(full));
  const plannedBefore = await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .plannedv`).textContent();
  const countBefore = await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .mcount`).textContent();
  await pbtn('o_norm').click(); await page.waitForTimeout(700); // flag one more order -> one more mirror
  check('mirror: flagging another order adds its mirror', (await mirrorNames()).includes('Normal Co'));
  check('colour: a preview of a non-autoship order is the standard teal', (await mirrorBg('Normal Co')) === TEAL, await mirrorBg('Normal Co'));
  check('mirror: does not change the month metrics or count', (await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .plannedv`).textContent()) === plannedBefore && (await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .mcount`).textContent()) === countBefore);
  const savedOrders = puts[puts.length - 1].orders.map((o) => o.order_id);
  check('mirror: never saved (no duplicate or extra orders)', new Set(savedOrders).size === savedOrders.length && savedOrders.length === (await page.evaluate(() => document.querySelectorAll('.shipment').length)), `${savedOrders.length}`);
  check('mirror: has no caption line (the Preemptive button says it all)', await page.evaluate(() => [...document.querySelectorAll('.pre-host')].every((h) => !h.shadowRoot.querySelector('.pre-cap') && !/placed early/.test(h.shadowRoot.textContent))));
  await pbtn('o_norm').click(); await page.waitForTimeout(700); // back to off
  check('mirror: turning the flag off removes it', !(await mirrorNames()).includes('Normal Co'));
  await page.locator('#inv-autoship-btn').click();
  check('mirror: hidden while a filter is active', (await m0list.locator('.month-preempt').count()) === 0);
  await page.locator('#inv-autoship-btn').click();

  const m1Panel = await page.locator(`.month[data-id="${M1.month}_${M1.year}"] .month-warn .warn-name`).allTextContents();
  // ── links: name -> Inventory, order month -> the order ──
  await rowFor(page, 'Runner').locator('.warn-name').click();
  await page.waitForTimeout(300);
  check('item name opens Inventory filtered to that item', (await page.locator('#inv-filter-item').inputValue()) === 'Runner' && await page.locator('#tab-inventory').isVisible());
  await page.locator('#inv-modal-close').click();
  await page.waitForTimeout(200);
  await rowFor(page, 'Later Placement').locator('.warn-month').first().click();
  await page.waitForTimeout(250);
  await page.waitForTimeout(900); // let the smooth scroll settle
  const cJump = await clearOfHead(page, '.card[data-id="oi_later"]');
  check('jumping to an item lands just BELOW the sticky month header (not under it)', cJump.ok, JSON.stringify(cJump));
  check('order month jumps to (and highlights) that order', await page.locator('.card[data-id="oi_later"]').evaluate((e) => e.classList.contains('warn-flash')));
  // a month link for an item that sits INSIDE an order scrolls to the ORDER (same as the Preemptive preview jump)
  await rowFor(page, 'Alpha').locator('.warn-month').first().click();
  await page.waitForTimeout(1000);
  const oJump = await clearOfHead(page, '.shipment[data-id="o_a"]');
  check('jumping from Needs Attention to an item in an order lands the ORDER just below the sticky header', oJump.ok, JSON.stringify(oJump));
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
  check('panel title is OUTSIDE the box, a section label like the others', await page.evaluate((id) => {
    const list = document.querySelector('.month[data-id="' + id + '"] > .month-list');
    const h = list.querySelector(':scope > .month-warn-head'), b = list.querySelector(':scope > .month-warn');
    return !!h && !!b && h.classList.contains('month-sec-head') && !b.contains(h) && h.getBoundingClientRect().bottom <= b.getBoundingClientRect().top + 1
      && getComputedStyle(h).textTransform === 'uppercase' && b.querySelectorAll('.warn-row').length > 0;
  }, M0.month + '_' + M0.year));
  // margin-top: ONLY the label that is truly first in a month's list gets the 4px "first" spacing
  const firstOnly = await page.evaluate((ids) => ids.map((id) => {
    const list = document.querySelector('.month[data-id="' + id + '"] > .month-list');
    const heads = [...list.querySelectorAll(':scope > .month-sec-head')];
    return heads.map((h) => ({ first: h === list.firstElementChild, mt: getComputedStyle(h).marginTop })).filter((x) => x.first || x.mt === '-4px');
  }), [M0.month + '_' + M0.year, M1.month + '_' + M1.year]);
  check('only the label that is really first in a month gets the -4px first-child margin', firstOnly.every((m) => m.length === 1 && m[0].first && m[0].mt === '-4px'), JSON.stringify(firstOnly));
  check('other section labels keep the normal 8px top margin', await page.evaluate((id) => [...document.querySelectorAll('.month[data-id="' + id + '"] > .month-list > .month-sec-head')].filter((h) => h !== h.parentNode.firstElementChild).every((h) => getComputedStyle(h).marginTop === '8px'), M1.month + '_' + M1.year));
  check('the "n completed" chip has no border and the 1px 9px 2px 9px padding', await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.warn-ign')); return c.borderTopStyle === 'none' && c.paddingTop === '1px' && c.paddingRight === '9px' && c.paddingBottom === '2px' && c.paddingLeft === '9px'; }));
  check('the title label matches the other section labels (same size/weight/colour)', await page.evaluate((id) => {
    const q = (sel) => { const e = document.querySelector('.month[data-id="' + id + '"] ' + sel); const c = getComputedStyle(e); return [c.fontSize, c.fontWeight, c.color, c.textTransform].join('|'); };
    return q('.month-list > .month-warn-head') === q('.month-list > .month-in-head');
  }, M0.month + '_' + M0.year));
  // ── search / filters apply to the Needs Attention rows too ──
  const q = page.locator('#global-search-input');
  const rowTexts = async () => (await panel(page).locator('.warn-row').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
  const nameList = async () => (await rowNames(page));
  const allRows = (await nameList()).length;
  await q.fill('alpha'); await page.waitForTimeout(300);
  const aRows = await rowTexts();
  check('search: Needs Attention shows only rows with a partial match (item OR order name)', aRows.length > 0 && aRows.length < allRows && aRows.every((x) => x.toLowerCase().includes('alpha')), aRows.join(' | '));
  check('search: a matching item is kept, and so are items in a matching order', (await nameList()).includes('Alpha') && (await nameList()).includes('Stale Approval'));
  check('search: run-out rows with no match are gone', !(await nameList()).includes('Runner') && !(await nameList()).includes('Late'));
  await q.fill('runn'); await page.waitForTimeout(300);
  check('search: a partial match also finds run-out rows (by item name)', (await nameList()).includes('Runner') && (await nameList()).every((n) => /runn/i.test(n)), (await nameList()).join(', '));
  await q.fill('zzqx'); await page.waitForTimeout(300);
  check('search: with no match the whole Needs Attention block is gone', (await panel(page).count()) === 0 && (await panelHead(page).count()) === 0);
  await q.fill(''); await page.waitForTimeout(300);
  check('clearing the search brings every row back', (await nameList()).length === allRows);
  await page.locator('#inv-autoship-btn').click(); await page.waitForTimeout(300);
  const autoNames = await nameList();
  check('Autoship filter: only rows with a saved autoship link (no run-outs)', autoNames.length > 0 && autoNames.includes('Alpha') && !autoNames.includes('Runner') && !autoNames.includes('Stale Approval'), autoNames.join(', '));
  await page.locator('#inv-autoship-btn').click(); await page.waitForTimeout(300);
  check('turning the filters off restores every row', (await nameList()).length === allRows);

  check('panel has no warning icon', (await panelHead(page).locator('svg').count()) === 0);
  const boxBg = await panel(page).evaluate((e) => getComputedStyle(e).backgroundColor);
  const shipBg = await page.evaluate(() => getComputedStyle(document.querySelector('.shipment[data-id="o_norm"]')).backgroundColor);
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

  // ── "completed" chip: ignored run-outs + approved autoships, restorable ──
  const chip = panelHead(page).locator('.warn-ign');
  const popRow = (n) => page.locator('.warn-ign-pop .wip-row', { has: page.locator('.wip-name', { hasText: new RegExp(`^${n}$`) }) });
  const completedN = async () => parseInt(await chip.textContent(), 10);
  const n0 = await completedN();
  check('chip counts the already-approved autoships as completed', n0 >= 1, await chip.textContent());
  await chip.hover();
  await page.waitForSelector('.warn-ign-pop .wip-row', { state: 'visible' });
  const apprDetail = (await popRow('Approved One').locator('.wip-detail').textContent()).trim();
  check('completed list shows an approved autoship, worded like the panel rows', /^autoships \d+\/\d+ · \S/.test(apprDetail), apprDetail);
  await page.mouse.move(5, 5); await page.waitForTimeout(400);

  await rowFor(page, 'Runner').locator('[data-act="warn-ignore"]').click();
  await page.waitForTimeout(150);
  check('Ignore removes the run-out row', !(await rowNames(page)).includes('Runner'));
  check('Ignore posts a dismiss with a month-scoped key', posts.some((b) => b.action === 'dismiss' && b.key === `runout|runner|${ym0}`), JSON.stringify(posts));
  check('"n completed" chip sits in the panel header (top right), not at the bottom', (await completedN()) === n0 + 1 && /completed$/.test((await chip.textContent()).trim()) && await chip.evaluate((c) => { const h = c.closest('.warn-head').getBoundingClientRect(), r = c.getBoundingClientRect(); return r.right > h.right - 40 && r.top < h.top + 30; }));
  check('no restore link at the bottom of the list any more', (await panel(page).locator('.warn-foot, .warn-restore').count()) === 0);
  await chip.hover();
  await page.waitForSelector('.warn-ign-pop .wip-row', { state: 'visible' });
  const runDetail = (await popRow('Runner').locator('.wip-detail').textContent()).trim();
  check('hovering the chip previews the ignored run-out (name + run-out date)', /^runs out \d+\/\d+$/.test(runDetail), runDetail);
  if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'ign-pop.png'), clip: { x: 0, y: 0, width: 900, height: 560 } });
  // layout: one line per item, Restore all in the header
  const lay = await page.evaluate(() => {
    const pop = document.querySelector('.warn-ign-pop').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.warn-ign-pop .wip-row')];
    const oneLine = rows.every((r) => { const n = r.querySelector('.wip-name').getBoundingClientRect(), d = r.querySelector('.wip-detail').getBoundingClientRect(); return Math.abs(n.top - d.top) < 6 && r.getBoundingClientRect().height < 44; });
    const all = document.querySelector('.warn-ign-pop .wip-all');
    const a = all && all.getBoundingClientRect(), first = rows[0].getBoundingClientRect();
    return { oneLine, allTopRight: !!a && a.bottom <= first.top + 2 && a.right > pop.right - 40 };
  });
  check('each completed item is a single line', lay.oneLine, JSON.stringify(lay));
  const heights = await page.evaluate(() => ({
    panel: [...document.querySelectorAll('.month-warn .warn-row')].slice(1, 4).map((r) => r.getBoundingClientRect().height),
    pop: [...document.querySelectorAll('.warn-ign-pop .wip-row')].slice(1).map((r) => r.getBoundingClientRect().height),
  }));
  check('completed items are the same height as the Needs Attention rows', heights.pop.length > 0 && heights.pop.every((h) => Math.abs(h - heights.panel[0]) <= 1), JSON.stringify(heights));
  check('Restore all sits in the top-right of the popover', lay.allTopRight, JSON.stringify(lay));
  await popRow('Runner').locator('[data-wip="one"]').click();
  await page.waitForTimeout(250);
  check('Restore brings the run-out row back', (await rowNames(page)).includes('Runner'));
  check('Restore posts an undismiss', posts.some((b) => b.action === 'undismiss' && b.key === `runout|runner|${ym0}`));
  check('the popover stays open for what is still completed', await page.locator('.warn-ign-pop').isVisible() && (await popRow('Approved One').count()) === 1);
  // restoring an APPROVED autoship un-approves it (back to a to-do row)
  await popRow('Approved One').locator('[data-wip="one"]').click();
  await page.waitForTimeout(500);
  check('restoring an approved autoship puts its row back on the list', (await rowNames(page)).includes('Approved One'));
  check('…and un-approves it in storage', !puts[puts.length - 1]?.items.find((i) => i.order_item_id === 'oi_approved')?.autoship_approved);
  await rowFor(page, 'Approved One').locator('[data-act="warn-approve"]').click(); // back to the fixture's state
  await page.waitForTimeout(400);
  await page.mouse.move(5, 5); await page.waitForTimeout(400);
  // …and an ignore survives a reload (server-side state), but only for THIS month's key
  await rowFor(page, 'Runner').locator('[data-act="warn-ignore"]').click();
  await page.waitForTimeout(150);
  await page.reload();
  await page.waitForSelector('#tab-board #board .month', { state: 'attached' });
  await page.waitForFunction(() => window._INV_ITEM_MAP && document.querySelector('.month-warn .warn-row'), null, { timeout: 10000 });
  await page.waitForTimeout(500);
  check('ignore survives a reload', !(await rowNames(page)).includes('Runner'));
  await panelHead(page).locator('.warn-ign').hover(); // leave the mock clean
  await popRow('Runner').locator('[data-wip="one"]').click();
  await page.waitForTimeout(250);
  await page.mouse.move(5, 5); await page.waitForTimeout(400);

  // ── several completed: restore one, then Restore all ──
  for (const n of ['Runner', 'Late']) { await rowFor(page, n).locator('[data-act="warn-ignore"]').click(); await page.waitForTimeout(120); }
  await page.evaluate(() => window.SupplementBoard.setAutoshipApproved('card', 'oi_approved', true)); // reload dropped the fixture approval
  await page.waitForTimeout(200);
  await panelHead(page).locator('.warn-ign').hover();
  await page.waitForSelector('.warn-ign-pop .wip-row', { state: 'visible' });
  const popNames = await page.locator('.warn-ign-pop .wip-name').allTextContents();
  check('popover lists every completed item (ignored + approved)', ['Runner', 'Late', 'Approved One'].every((n) => popNames.includes(n)), popNames.join(', '));
  await popRow('Late').locator('[data-wip="one"]').click();
  await page.waitForTimeout(250);
  check('restoring one leaves the others completed (popover stays open for them)', (await rowNames(page)).includes('Late') && !(await rowNames(page)).includes('Runner') && await page.locator('.warn-ign-pop').isVisible());
  await panelHead(page).locator('.warn-ign').hover();
  await page.waitForSelector('.warn-ign-pop [data-wip="all"]');
  await page.locator('.warn-ign-pop [data-wip="all"]').click();
  await page.waitForTimeout(500);
  const afterAll = await rowNames(page);
  check('Restore all brings every completed item back', ['Runner', 'Late', 'Approved One'].every((n) => afterAll.includes(n)) && (await panelHead(page).locator('.warn-ign').count()) === 0 && !(await page.locator('.warn-ign-pop').isVisible()), afterAll.join(', '));
  await rowFor(page, 'Approved One').locator('[data-act="warn-approve"]').click(); // restore the fixture's approval for what follows
  await page.waitForTimeout(300);
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

  // ── "Move to" / "Copy to" order pickers list the month's orders alphabetically by shipment name ──
  await page.locator('.card[data-id="oi_early"] .card-grip').first().evaluate((g) => g.scrollIntoView({ block: 'center' }));
  await page.mouse.move(5, 5); await page.waitForTimeout(300);
  await page.locator('.card[data-id="oi_early"] .card-grip').first().click();
  await page.waitForSelector('.ship-ctx-menu .ship-ctx-pick');
  const pickers = await page.evaluate(() => [...document.querySelectorAll('.ship-ctx-menu .ship-ctx-pick')]
    .map((row) => ({ cap: row.querySelector('span').textContent, opts: [...row.querySelectorAll('select option')].map((o) => o.textContent) }))
    .filter((p) => p.opts[0] === 'Order')
    .map((p) => ({ cap: p.cap, names: p.opts.slice(1).map((x) => x.replace(/ \(\d+\).*$/, '')) })));
  const alpha = (n) => [...n].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  check('both order pickers exist (Move to / Copy to) with several orders to choose from', pickers.length === 2 && pickers.every((p) => p.names.length >= 4), JSON.stringify(pickers));
  check('"Move to" and "Copy to" list the orders alphabetically by shipment name', pickers.every((p) => JSON.stringify(p.names) === JSON.stringify(alpha(p.names))), JSON.stringify(pickers.map((p) => p.names)));
  check('the card\'s own order and completed orders are still left out', pickers.every((p) => !p.names.includes('Pre Auto Co') && !p.names.includes('Locked Nov')));
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5); await page.waitForTimeout(300);

  // ── clicking an item's NAME searches for it; clicking its run-out METRICS opens it in Inventory ──
  const covered = '.card[data-id="oi_covered"]';
  await page.locator(covered).evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
  await page.mouse.move(5, 5); await page.waitForTimeout(300);
  check('a tracked item\'s name is a "search for this item" link, its metrics an "open in Inventory" link', await page.evaluate((q) => {
    const c = document.querySelector(q);
    return c.querySelector('.card-name').dataset.act === 'search-item' && c.querySelector('.proj .pv').dataset.act === 'open-inv-item';
  }, covered));
  await page.locator(covered + ' .card-name').click();
  await page.waitForTimeout(500);
  const searched = await page.evaluate(() => ({
    box: document.getElementById('global-search-input').value,
    shown: [...document.querySelectorAll('#board .card')].filter((c) => c.offsetParent !== null).map((c) => c.querySelector('.card-name').textContent.trim()),
  }));
  check('clicking the name puts it in the Search bar', searched.box === 'Covered', searched.box);
  check('…and filters the board to that item', searched.shown.length > 0 && searched.shown.every((n) => /covered/i.test(n)), searched.shown.join(', '));
  check('…without opening Inventory', !(await page.locator('#inv-filter-item').isVisible()));
  const monthIdOfM2 = M2.month + '_' + M2.year;
  // search for something that only exists in a FUTURE month: that month becomes the leftmost one in view
  await page.locator('#global-search-input').fill('Later Placement');
  await page.waitForTimeout(500);
  const farAway = await page.evaluate(() => [...document.querySelectorAll('#board .month')].find((m) => m.offsetParent !== null).dataset.id);
  await page.locator('#global-search-clear').click();
  await page.waitForTimeout(500);
  const atRoot = await page.evaluate(() => { const s = document.getElementById('tab-board').getBoundingClientRect(); const fe = [...document.querySelectorAll('#board .month')].find((m) => m.offsetParent !== null); const f = fe.getBoundingClientRect(); return { first: fe.dataset.id, dx: Math.round(f.left - s.left), dy: Math.round(f.top - s.top) }; });
  check('clearing a search jumps back to the first month (not wherever the board was scrolled)', farAway === monthIdOfM2 && atRoot.first !== farAway && Math.abs(atRoot.dx) < 40 && Math.abs(atRoot.dy) < 40, JSON.stringify({ farAway, atRoot }));
  check('clearing the search brings every item back', (await page.evaluate(() => [...document.querySelectorAll('#board .card')].filter((c) => c.offsetParent !== null).length)) > 3);

  // ── filtering must not confuse which month is "current", and the board scrolls sideways on a held middle button ──
  await page.evaluate(() => { const i = document.getElementById('global-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(500);
  const glide = await page.evaluate(() => {
    const i = document.getElementById('global-search-input');
    i.value = 'Later Placement'; i.dispatchEvent(new Event('input', { bubbles: true }));
    const n = document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('month')).length;
    return n;
  });
  check('filtering animates the month columns into their new places (a glide, not a jump)', glide >= 1, String(glide));
  await page.waitForTimeout(500);
  const unfilter = await page.evaluate(() => {
    document.getElementById('global-search-clear').click();
    return { fresh: document.querySelectorAll('#board .sb-fresh').length, monthAnims: document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('month')).length };
  });
  check('clearing the filter fades the months and orders it brings back', unfilter.monthAnims >= 1 && unfilter.fresh >= 1, JSON.stringify(unfilter));
  await page.waitForTimeout(700);
  const settled = await page.evaluate(() => ({ fresh: document.querySelectorAll('#board .sb-fresh').length, transforms: [...document.querySelectorAll('#board > .month')].filter((m) => m.offsetParent).every((m) => getComputedStyle(m).transform === 'none'), running: document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#board')).length }));
  check('…and everything settles: no leftover fade class, no stuck transform', settled.fresh === 0 && settled.transforms && settled.running === 0, JSON.stringify(settled));
  await page.locator('#global-search-input').fill('Later Placement');
  await page.waitForTimeout(500);
  const curWhileFiltered = await page.evaluate(() => ({ cur: document.querySelector('.month-strip-cell.is-current')?.dataset.monthId, shown: [...document.querySelectorAll('#board > .month')].filter((m) => m.offsetParent).map((m) => m.dataset.id) }));
  check('while filtered, the "current" month is one that is actually shown', curWhileFiltered.shown.length > 0 && curWhileFiltered.shown.includes(curWhileFiltered.cur), JSON.stringify(curWhileFiltered));
  await page.locator('#global-search-clear').click();
  await page.waitForTimeout(400);
  const tbLeft = () => page.evaluate(() => Math.round(document.getElementById('tab-board').scrollLeft));
  await page.evaluate(() => document.getElementById('tab-board').scrollTo(0, 0));
  await page.mouse.move(700, 600);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(1000, 600, { steps: 6 });
  await page.waitForTimeout(500);
  const heldRight = await tbLeft();
  const ownScroll = await page.evaluate(() => document.body.classList.contains('mid-scrolling'));
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(150);
  const afterRelease = await tbLeft();
  await page.waitForTimeout(300);
  check("holding the middle button and moving right scrolls the board sideways (by the board's own autoscroll)", heldRight > 200 && ownScroll, JSON.stringify({ heldRight, ownScroll }));
  check('…and releasing it stops', (await tbLeft()) === afterRelease && afterRelease - heldRight < 400, JSON.stringify({ heldRight, afterRelease, later: await tbLeft() }));
  await page.mouse.move(700, 600);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(400, 600, { steps: 6 });
  await page.waitForTimeout(500);
  await page.mouse.up({ button: 'middle' });
  check('…and moving left scrolls back', (await tbLeft()) < afterRelease - 100, JSON.stringify({ afterRelease, now: await tbLeft() }));
  await page.mouse.move(700, 600);
  await page.mouse.down({ button: 'middle' }); await page.mouse.up({ button: 'middle' }); // a plain click: keeps going
  await page.mouse.move(1000, 600, { steps: 6 });
  const click0 = await tbLeft();
  await page.waitForTimeout(500);
  const click1 = await tbLeft();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const click2 = await tbLeft();
  await page.waitForTimeout(300);
  check('a plain middle click starts autoscroll that runs until Escape', click1 > click0 + 100 && (await tbLeft()) === click2, JSON.stringify({ click0, click1, click2, later: await tbLeft() }));
  check('…and the board shows no stuck autoscroll cursor afterwards', !(await page.evaluate(() => document.body.classList.contains('mid-scrolling'))));
  await page.evaluate(() => document.getElementById('tab-board').scrollTo(0, 0));
  await page.locator(covered).evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
  await page.locator(covered + ' .proj .pv').click();
  await page.waitForSelector('#inv-filter-item', { state: 'visible' });
  await page.waitForTimeout(300);
  check('clicking the run-out metrics opens the item in Inventory', (await page.locator('#inv-filter-item').inputValue()) === 'Covered');
  check('…and leaves the board\'s Search bar alone', (await page.locator('#global-search-input').inputValue()) === '');
  await page.locator('#inv-filter-item').fill(''); // leave the Inventory filter clear for the checks after this
  await page.locator('#inv-modal-close').click();
  await page.waitForTimeout(200);

  // ── changing an item's Autoship date to a DIFFERENT month moves it to that month ──
  const monthIdOf = (m) => m.month + '_' + m.year;
  const inMonth = (id) => page.evaluate((i) => { const c = document.querySelector('.card[data-id="' + i + '"]'); const m = c.closest('.month'); const s = c.closest('.shipment'); return { month: m.dataset.id, ship: s ? s.querySelector('.ship-name').textContent.trim() : null }; }, id);
  const setDate = async (id, d) => { await page.evaluate(({ id, d }) => window.SupplementBoard.saveCardAutoship(id, '', d), { id, d }); await page.waitForTimeout(150); };
  const day = (m, n) => iso(new Date(m.start.getFullYear(), m.start.getMonth(), n));
  check('move setup: the loose test item starts in next month', (await inMonth('oi_far')).month === monthIdOf(M1));
  await setDate('oi_far', day(M3, 25)); // same month as before (the original date was the 20th of that month)
  check('Autoship: a new date in the SAME month leaves the item where it is', (await inMonth('oi_far')).month === monthIdOf(M1));
  await setDate('oi_far', day(M2, 12));
  check('Autoship: a date in a DIFFERENT month moves the item to that month', (await inMonth('oi_far')).month === monthIdOf(M2), JSON.stringify(await inMonth('oi_far')));
  await page.waitForTimeout(700);
  check('…and the move is saved', puts[puts.length - 1]?.items.find((i) => i.order_item_id === 'oi_far')?.month === M2.month, JSON.stringify(puts[puts.length - 1]?.items.find((i) => i.order_item_id === 'oi_far')));
  await setDate('oi_far', day(M2, 14));
  check('Autoship: another date in that same month stays put', (await inMonth('oi_far')).month === monthIdOf(M2));
  await setDate('oi_far', '');
  check('Autoship: clearing the date does not move it', (await inMonth('oi_far')).month === monthIdOf(M2));
  await setDate('oi_far', day(M1, 20));
  check('Autoship: setting a date where there was none does not move it', (await inMonth('oi_far')).month === monthIdOf(M2));
  await setDate('oi_far', day(M0, 9));
  check('Autoship: an EARLIER month works too', (await inMonth('oi_far')).month === monthIdOf(M0));
  await setDate('oi_far', iso(new Date(M0.year - 5, 0, 5)));
  check('Autoship: a month that is not on the board leaves it where it is', (await inMonth('oi_far')).month === monthIdOf(M0));
  await setDate('oi_far', day(M3, 20));
  // inside an order: it follows into the same-named order of the target month
  check('move setup: an item inside "Alpha Shop" in this month', JSON.stringify(await inMonth('oi_nextmid')) === JSON.stringify({ month: monthIdOf(M0), ship: 'Alpha Shop' }));
  await setDate('oi_nextmid', day(M2, 9));
  const mvShip = await inMonth('oi_nextmid');
  check('Autoship: an item in an order moves into an order of the SAME NAME in the target month', mvShip.month === monthIdOf(M2) && mvShip.ship === 'Alpha Shop', JSON.stringify(mvShip));
  await setDate('oi_nextmid', day(M0, 11));
  check('Autoship: …and can be moved back into the original order', JSON.stringify(await inMonth('oi_nextmid')) === JSON.stringify({ month: monthIdOf(M0), ship: 'Alpha Shop' }), JSON.stringify(await inMonth('oi_nextmid')));
  // an item in a placed (locked) order never moves
  await setDate('oi_locked', day(M2, 9));
  check('Autoship: an item in a placed (Ordered) order stays in its order', (await inMonth('oi_locked')).month === monthIdOf(M0));
  await setDate('oi_locked', D_LOCKED);

  // ── at 0 left to act on, the whole panel goes away ──
  for (let i = 0; i < 40; i++) {
    const b = panel(page).locator('[data-act="warn-approve"], [data-act="warn-ignore"]').first();
    if (!(await b.count())) break;
    await b.click(); await page.waitForTimeout(80);
  }
  check('with 0 items left the entire panel (title and box) is gone', (await panel(page).count()) === 0 && (await panelHead(page).count()) === 0);
  dismissed.clear(); // the mock server's ignore list, so the mobile pass below starts clean

  // ── Inventory table: editing On Hand re-patches the row; "Lasts For" must stay a day count ──
  await page.locator('#inv-search-link').click();
  await page.waitForSelector('#inv-body tr[data-key="runner"]');
  const lasts = () => page.locator('#inv-body tr[data-key="runner"] .inv-dpb').textContent();
  check('Lasts For starts as a day count', /^\d+(\.\d)?d$/.test((await lasts()).trim()), await lasts());
  const visRows = () => page.evaluate(() => [...document.querySelectorAll('#inv-body tr[data-key]')].filter((tr) => tr.style.display !== 'none').map((tr) => ({ key: tr.dataset.key, name: tr.querySelector('.inv-name').textContent.trim(), ro: tr.querySelectorAll('td')[1].textContent })));
  const visCards = () => page.evaluate(() => [...document.querySelectorAll('#inv-cards .inv-card[data-key]')].filter((c) => c.style.display !== 'none').map((c) => ({ name: c.querySelector('.inv-card-name').textContent.trim(), ro: c.querySelector('.inv-card-runout').textContent })));
  const roDays = (txt) => { const m = /\((\d+)d\)/.exec(txt); return m ? Number(m[1]) : (/EMPTY/.test(txt) ? -1 : 1e9); };
  await page.locator('#inv-soon-btn').click();
  const soonRows = await visRows(), soonCards = await visCards();
  const inOrder = (rows) => rows.every((r, i) => i === 0 || roDays(rows[i - 1].ro) <= roDays(r.ro));
  const soonNames = (rows) => rows.map((r) => r.name);
  check('"Soon" lists items by run-out date (soonest first), not alphabetically', soonRows.length >= 4 && inOrder(soonRows) && soonNames(soonRows).indexOf('Runner') >= 0 && soonNames(soonRows).indexOf('Runner') < soonNames(soonRows).indexOf('Next Runner'), JSON.stringify(soonRows.map((r) => [r.name, roDays(r.ro)])));
  check('…and so do the mobile cards', soonCards.length === soonRows.length && inOrder(soonCards) && soonNames(soonCards).join() === soonNames(soonRows).join(), JSON.stringify(soonNames(soonCards)));
  await page.locator('#inv-soon-btn').click();
  const allKeys = (await visRows()).map((r) => r.key);
  check('switching "Soon" off restores the alphabetical list', allKeys.length > soonRows.length && allKeys.every((k, i) => i === 0 || allKeys[i - 1] <= k), allKeys.join());
  await page.locator('#inv-body tr[data-key="runner"] .inv-onhand').click();
  await page.locator('#inv-body tr[data-key="runner"] input').fill('30');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const todayMD = `${now.getMonth() + 1}/${now.getDate()}`;
  check('after editing On Hand, Lasts For is still a day count (not the reset date)', /^\d+(\.\d)?d$/.test((await lasts()).trim()), await lasts());
  check('…and Last Reset got the date instead', (await page.locator('#inv-body tr[data-key="runner"] .inv-reset').textContent()).trim() === todayMD);
  await page.locator('#inv-modal-close').click();
  await page.waitForTimeout(200);

  // ── Inventory is a round button bottom-right; Scan lives in the Inventory window; one "clear all filters" button ──
  check('the Inventory button is no longer in the header', await page.evaluate(() => !document.querySelector('header #inv-search-link, header .inv-search-link, header #inv-scan-btn')));
  const fab = await page.evaluate(() => { const b = document.getElementById('inv-search-link'), r = b.getBoundingClientRect(), cs = getComputedStyle(b); const sv = b.querySelector('svg').getBoundingClientRect(); return { pos: getComputedStyle(b.parentElement).position, radius: cs.borderRadius, w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), svg: [Math.round(sv.width), Math.round(sv.height)] }; });
  check('Inventory is a round teal button fixed at the bottom-right (same as the old mobile Scan one)', fab.pos === 'fixed' && fab.radius === '50%' && fab.w === 52 && fab.h === 52 && fab.right === 16 && fab.bottom === 24, JSON.stringify(fab));
  check('…with a 40x40 icon inside it', fab.svg[0] === 40 && fab.svg[1] === 40, JSON.stringify(fab.svg));
  check('there is no "Show Scan Button" setting any more', (await page.locator('#show-scan-toggle').count()) === 0);
  await page.locator('#inv-search-link').click();
  await page.waitForSelector('#inv-modal-ov.open');
  check('popovers ease in: the Inventory window fades/rises into place', await page.evaluate(() => getComputedStyle(document.getElementById('inv-modal-ov')).animationName === 'np-backdrop-in' && getComputedStyle(document.getElementById('tab-inventory')).animationName === 'np-pop-in'));
  await page.waitForTimeout(350); // let the entrance finish before measuring anything
  const head = await page.evaluate(() => { const sc = document.getElementById('inv-scan-btn'), cl = document.getElementById('inv-modal-close'), a = sc.getBoundingClientRect(), b = cl.getBoundingClientRect(); return { inHead: !!sc.closest('.inv-modal-head'), nextIsClose: sc.nextElementSibling === cl, gap: Math.round(b.left - a.right), sameRow: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 2, visible: getComputedStyle(sc).display !== 'none' }; });
  check("Scan is in the Inventory window's top-right, just left of the close button, always shown", head.inHead && head.nextIsClose && head.visible && head.sameRow && head.gap >= 0 && head.gap <= 16, JSON.stringify(head));
  await page.locator('#inv-scan-btn').click();
  await page.waitForTimeout(300);
  check('…and it opens the scanner over the Inventory window', await page.evaluate(() => document.getElementById('scan-overlay')?.style.display === 'flex'));
  await page.evaluate(() => document.getElementById('scan-close-btn')?.click());
  await page.waitForTimeout(200);
  const sizes = await page.evaluate(() => { const q = (s) => { const e = document.querySelector(s), r = e.getBoundingClientRect(), cs = getComputedStyle(e); return [Math.round(r.height * 10) / 10, cs.borderRadius, cs.borderTopWidth]; }; return { autoship: q('#inv-autoship-btn'), search: q('.global-search-box'), clear: q('#global-search-clear'), noorder: q('#inv-noorder-btn'), soon: q('#inv-soon-btn'), scan: q('#inv-scan-btn') }; });
  check("Inventory's No Order / Soon / Scan match the board's top-row controls (30px tall, 7px radius, same border)", Object.values(sizes).every((v) => v[0] === 30 && v[1] === '7px' && v[2] === sizes.search[2]), JSON.stringify(sizes));
  await page.locator('#inv-modal-close').click();
  await page.waitForTimeout(200);
  const clr = await page.evaluate(() => { const c = document.getElementById('global-search-clear'), box = document.querySelector('.global-search-box'); return { outside: !box.contains(c), right: c.getBoundingClientRect().left >= box.getBoundingClientRect().right, disabled: c.disabled, tiny: !!document.querySelector('.global-search-clear') }; });
  check('the × is its own button right of the Search bar (none inside it), disabled with no filters', clr.outside && clr.right && clr.disabled && !clr.tiny, JSON.stringify(clr));
  await page.locator('#global-search-input').fill('zzz');
  check('…enabled once a search is typed', !(await page.locator('#global-search-clear').isDisabled()));
  await page.locator('#global-search-clear').click();
  await page.waitForTimeout(300);
  check('…and clicking it clears the search and disables it again', (await page.locator('#global-search-input').inputValue()) === '' && (await page.locator('#global-search-clear').isDisabled()));
  await page.locator('#inv-autoship-btn').click();
  check('…enabled for the Autoship filter too', !(await page.locator('#global-search-clear').isDisabled()));
  await page.locator('#global-search-clear').click();
  await page.waitForTimeout(300);
  check('…which it clears', !(await page.locator('#inv-autoship-btn').evaluate((e) => e.classList.contains('active'))) && (await page.locator('#global-search-clear').isDisabled()));
  check('search box: flex is "0 1 90px"', await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.global-search-box')); return c.flexGrow === '0' && c.flexShrink === '1' && c.flexBasis === '90px'; }));

  // ── layout: header and board padding, and the text logo only from 1250px wide ──
  check('header padding is 0 16px, board padding 16px', await page.evaluate(() => { const h = getComputedStyle(document.querySelector('header')), b = getComputedStyle(document.querySelector('#tab-board .board')); return h.paddingTop === '0px' && h.paddingLeft === '16px' && h.paddingRight === '16px' && [b.paddingTop, b.paddingRight, b.paddingBottom, b.paddingLeft].every((v) => v === '16px'); }));
  const h1Shown = () => page.evaluate(() => getComputedStyle(document.querySelector('.brand h1')).display !== 'none');
  await page.setViewportSize({ width: 1250, height: 900 });
  check('the "Normal Protocol" text logo shows at 1250px', await h1Shown());
  await page.setViewportSize({ width: 1249, height: 900 });
  check('…and is hidden below 1250px (the logo mark stays)', !(await h1Shown()) && (await page.locator('.brand img').isVisible()));
  await page.setViewportSize({ width: 1400, height: 900 });
  check('…and is back on a wide screen', await h1Shown());

  // ── desktop: a month strip that does not fit scrolls sideways, with a scrollbar only while the pointer is over it ──
  await page.setViewportSize({ width: 700, height: 900 });
  await page.mouse.move(600, 600);
  await page.waitForTimeout(300);
  const stripInfo = () => page.evaluate(() => { const s = document.getElementById('month-strip'); const cs = getComputedStyle(s); return { ox: cs.overflowX, over: s.scrollWidth - s.clientWidth, left: Math.round(s.scrollLeft), hot: s.classList.contains('strip-hot'), thumb: getComputedStyle(s, '::-webkit-scrollbar-thumb').backgroundColor }; });
  const s0 = await stripInfo();
  check('month strip: scrolls sideways on desktop when the months do not all fit', s0.ox === 'auto' && s0.over > 20, JSON.stringify(s0));
  check('…and shows no scrollbar while the pointer is elsewhere', !s0.hot && ['rgba(0, 0, 0, 0)', 'transparent'].includes(s0.thumb), JSON.stringify(s0));
  const sb = await page.locator('#month-strip').boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.waitForTimeout(150);
  const s1 = await stripInfo();
  check('…and shows a thin one while the pointer is over the strip', s1.hot && !['rgba(0, 0, 0, 0)', 'transparent'].includes(s1.thumb), JSON.stringify(s1));
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);
  const s2 = await stripInfo();
  check('…and a plain mouse wheel over it scrolls it sideways', s2.left > 0, JSON.stringify(s2));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  const s3 = await stripInfo();
  check('…and the scrollbar hides again once the pointer leaves', !s3.hot && ['rgba(0, 0, 0, 0)', 'transparent'].includes(s3.thumb), JSON.stringify(s3));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(200);

  // ── nothing leaks into past/other structure ──
  check('no JS errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // ── Receive: a quantity-mode "decrement" item (blank Price, no Dose/Day) must WITHDRAW -- never preview or log an increase ──
  {
    const rc = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const rp = await rc.newPage();
    const logged = [];
    const rBody = {
      months: [{ month: M0.month, year: M0.year, position: 1 }],
      orders: [{ order_id: 'o_v', month: M0.month, year: M0.year, merchant: 'Visits Co', position: 1, status: 'Staged', notes: null }],
      items: [
        card('oi_visit', 'o_v', M0, 1, 1, 'Visits', { price_per_bottle: null }),   // blank Price, no dose: 1 visit CONSUMED
        card('oi_bottle', 'o_v', M0, 1, 2, 'Bottled', { price_per_bottle: 10, order_qty_bottles: 2 }), // a normal purchase of 2 bottles
      ],
    };
    const rItems = [{ id: 21, name: 'Visits', bottle_size: 3, daily_dose: 0 }, { id: 22, name: 'Bottled', bottle_size: 60, daily_dose: 1 }];
    const rLog = [{ id: 21, item: 'Visits', type: 'Reset', amount: 5, logged_on: iso(now), order_id: null }, { id: 22, item: 'Bottled', type: 'Reset', amount: 100, logged_on: iso(now), order_id: null }];
    await rp.route('**/api/orders', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rBody) }) : r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })));
    await rp.route('**/api/inventory-items', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rItems) }));
    await rp.route((u) => new URL(u).pathname === '/api/inventory', (r) => {
      const m = r.request().method();
      if (m === 'POST') { logged.push(JSON.parse(r.request().postData() || '{}')); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
      if (m === 'GET' && !r.request().url().includes('order_id=')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rLog) });
      return r.fulfill({ status: 200, contentType: 'application/json', body: m === 'GET' ? '[]' : '{"ok":true}' });
    });
    await rp.goto(base, { waitUntil: 'load' });
    await rp.waitForSelector('.shipment[data-id="o_v"]', { state: 'attached', timeout: 15000 });
    await rp.waitForSelector('.card[data-id="oi_visit"]:not(.no-proj)', { timeout: 10000 });
    await rp.evaluate(() => document.querySelector('.shipment[data-id="o_v"] [data-act="set-stage"][data-stage="received"]').click());
    await rp.waitForSelector('#recv-confirm-body tr .rc-after', { timeout: 10000 });
    const rows = await rp.evaluate(() => Object.fromEntries([...document.querySelectorAll('#recv-confirm-body tr')].map((tr) => [tr.querySelector('.rc-name')?.textContent.trim(), tr.querySelector('.rc-after')?.textContent.split(/ +/).join(' ').trim()])));
    check('Confirm Receive: a decrement item previews a DECREASE (5 -> 4, not 5 -> 8)', (rows.Visits || '').split(' ').join('') === '4(-1)', JSON.stringify(rows));
    check('…while an ordinary purchase still previews an increase (2 bottles of 60)', (rows.Bottled || '').split(' ').join('') === '220(+120)', JSON.stringify(rows));
    await rp.locator('#recv-confirm-approve-btn').click();
    await rp.waitForTimeout(800);
    const rec = (n) => logged.find((l) => l.item === n && l.type === 'Received');
    check('Receive logs the decrement as a negative amount', rec('Visits')?.amount === -1, JSON.stringify(logged));
    check('…and the purchase as a positive one', rec('Bottled')?.amount === 120, JSON.stringify(logged));
    await rc.close();
  }

  // ── placing an order (Ordered/Entered) in a FUTURE month flags it Preemptive ──
  {
    const pc = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const pp = await pc.newPage();
    const pPuts = [];
    const pBody = {
      months: [{ month: M0.month, year: M0.year, position: 1 }, { month: M1.month, year: M1.year, position: 2 }],
      orders: [
        { order_id: 'o_now', month: M0.month, year: M0.year, merchant: 'Now Co', position: 1, status: 'Staged', notes: null },
        { order_id: 'o_f1', month: M1.month, year: M1.year, merchant: 'Future One', position: 1, status: 'Staged', notes: null },
        { order_id: 'o_f2', month: M1.month, year: M1.year, merchant: 'Future Two', position: 2, status: 'Staged', notes: null },
        { order_id: 'o_f3', month: M1.month, year: M1.year, merchant: 'Future Three', position: 3, status: 'Staged', notes: null },
        { order_id: 'o_f4', month: M1.month, year: M1.year, merchant: 'Future Four', position: 4, status: 'Staged', notes: null, preemptive: 0 },
      ],
      items: ['o_now', 'o_f1', 'o_f2', 'o_f3', 'o_f4'].map((o, i) => card('pi_' + o, o, o === 'o_now' ? M0 : M1, i + 1, 1, 'Thing ' + o, {})),
    };
    await pp.route('**/api/orders', (r) => {
      if (r.request().method() === 'PUT') { pPuts.push(JSON.parse(r.request().postData() || '{}')); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pBody) });
    });
    await pp.route('**/api/inventory-items', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await pp.route((u) => new URL(u).pathname === '/api/inventory', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: r.request().method() === 'GET' ? '[]' : '{"ok":true}' }));
    await pp.goto(base, { waitUntil: 'load' });
    await pp.waitForSelector('.shipment[data-id="o_f1"]', { state: 'attached', timeout: 15000 });
    const stageIt = (id, st) => pp.evaluate(({ id, st }) => document.querySelector('.shipment[data-id="' + id + '"] [data-act="set-stage"][data-stage="' + st + '"]').click(), { id, st });
    const isOn = (id) => pp.evaluate((i) => document.querySelector('.shipment[data-id="' + i + '"] .ship-preempt').classList.contains('is-on'), id);
    check('future-month orders start out not Preemptive', !(await isOn('o_f1')) && !(await isOn('o_f2')) && !(await isOn('o_f4')));
    await stageIt('o_now', 'ordered');
    await stageIt('o_f1', 'ordered');
    await stageIt('o_f2', 'entered');
    await pp.waitForTimeout(900);
    check('Ordered in a future month turns Preemptive on', await isOn('o_f1'));
    check('Entered in a future month turns Preemptive on', await isOn('o_f2'));
    check('Ordered in the CURRENT month does not', !(await isOn('o_now')));
    check('an order that is merely Staged in a future month is left alone', !(await isOn('o_f3')));
    const saved = pPuts[pPuts.length - 1]?.orders || [];
    const sv = (id) => saved.find((o) => o.order_id === id)?.preemptive;
    check('…and the flag is saved with the order', sv('o_f1') === 1 && sv('o_f2') === 1 && sv('o_now') == null && sv('o_f3') == null, JSON.stringify(saved.map((o) => [o.order_id, o.preemptive])));
    await stageIt('o_f4', 'ordered'); // manually forced OFF before: placing it in a future month still flags it
    await pp.waitForTimeout(600);
    check('…even over an earlier manual "off"', await isOn('o_f4'));
    await stageIt('o_f1', 'ordered'); // clear the stage again
    await pp.waitForTimeout(600);
    check('clearing the stage afterwards leaves it Preemptive', await isOn('o_f1'));
    await pc.close();
  }

  // ── Settings > Configure Merchants Shorthand: abbreviations below 1250px, full names kept underneath ──
  {
    const sc = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const sp = await sc.newPage();
    let shList = [];
    const shPosts = [];
    const sBody = {
      months: [{ month: M0.month, year: M0.year, position: 1 }],
      orders: [
        { order_id: 'o_bs', month: M0.month, year: M0.year, merchant: 'Blue Sky Vitamin', position: 1, status: 'Staged', notes: null },
        { order_id: 'o_ot', month: M0.month, year: M0.year, merchant: 'Other Co', position: 2, status: 'Staged', notes: null },
      ],
      items: [card('si_1', 'o_bs', M0, 1, 1, 'Thing A', {}), card('si_2', 'o_ot', M0, 2, 1, 'Thing B', {})],
    };
    const jsonRes = (r, obj) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
    await sp.route('**/api/orders', (r) => (r.request().method() === 'GET' ? jsonRes(r, sBody) : jsonRes(r, { ok: true })));
    await sp.route('**/api/inventory-items', (r) => jsonRes(r, []));
    await sp.route((u) => new URL(u).pathname === '/api/inventory', (r) => jsonRes(r, r.request().method() === 'GET' ? [] : { ok: true }));
    await sp.route('**/api/board-settings', (r) => {
      if (r.request().method() === 'POST') {
        const b = JSON.parse(r.request().postData() || '{}');
        shPosts.push(b);
        if (b.action === 'shorthand-set') shList = [...shList.filter((e) => e.name.toLowerCase() !== b.name.toLowerCase()), { name: b.name, short: b.short }];
        if (b.action === 'shorthand-clear') shList = shList.filter((e) => e.name.toLowerCase() !== b.name.toLowerCase());
        return jsonRes(r, { ok: true, merchantShorthand: shList, pinnedMerchants: ['Blue Sky Vitamin'] });
      }
      return jsonRes(r, { pinnedMerchants: ['Blue Sky Vitamin'], dismissedWarnings: [], merchantShorthand: shList });
    });
    await sp.goto(base, { waitUntil: 'load' });
    await sp.waitForSelector('.shipment[data-id="o_bs"]', { state: 'attached', timeout: 15000 });
    await sp.waitForSelector('#pinned-merchants-desktop .pin-chip', { state: 'attached', timeout: 10000 });
    check('Settings has a "Configure Merchants Shorthand" button', (await sp.locator('#config-shorthand').textContent()).trim() === 'Configure Merchants Shorthand');
    await sp.locator('#settings-btn').click();
    await sp.locator('#config-shorthand').click();
    await sp.waitForSelector('#shorthand-overlay', { state: 'visible' });
    const anim = () => sp.evaluate(() => ({ ov: getComputedStyle(document.getElementById('shorthand-overlay')).animationName, modal: getComputedStyle(document.querySelector('#shorthand-overlay .scan-modal')).animationName }));
    const animOn = await anim();
    check('popovers ease in: the Merchants Shorthand backdrop fades up and its window rises', animOn.ov === 'np-backdrop-in' && animOn.modal === 'np-pop-in', JSON.stringify(animOn));
    await sp.emulateMedia({ reducedMotion: 'reduce' });
    const animRm = await anim();
    check('…and not for people who ask for reduced motion', animRm.ov === 'none' && animRm.modal === 'none', JSON.stringify(animRm));
    await sp.emulateMedia({ reducedMotion: 'no-preference' });
    check('…it opens a modal, with the board\'s merchants suggested', await sp.evaluate(() => /No shorthand yet/.test(document.querySelector('#shorthand-overlay .sh-list').textContent) && [...document.querySelectorAll('#shorthand-names option')].some((o) => o.value === 'Blue Sky Vitamin')));
    await sp.locator('#shorthand-name').fill('Blue Sky Vitamin');
    await sp.locator('#shorthand-short').fill('BSV');
    await sp.locator('#shorthand-add-btn').click();
    await sp.waitForTimeout(400);
    check('adding a pair saves it (atomic POST) and lists it', shPosts.some((p) => p.action === 'shorthand-set' && p.name === 'Blue Sky Vitamin' && p.short === 'BSV') && (await sp.locator('#shorthand-overlay .sh-row').count()) === 1 && (await sp.locator('#shorthand-overlay .sh-row input').inputValue()) === 'BSV');
    await sp.keyboard.press('Escape');
    check('Escape closes the modal', !(await sp.locator('#shorthand-overlay').isVisible()));
    const probe = () => sp.evaluate(() => {
      const nm = document.querySelector('.shipment[data-id="o_bs"] .ship-name'), other = document.querySelector('.shipment[data-id="o_ot"] .ship-name');
      const chip = document.querySelector('#pinned-merchants-desktop .pin-chip'), vis = (e) => !!e && getComputedStyle(e).display !== 'none';
      return {
        text: nm.textContent, short: nm.dataset.short, after: getComputedStyle(nm, '::after').content, width: Math.round(nm.getBoundingClientRect().width),
        otherShort: other.dataset.short, otherText: other.textContent, full: vis(chip.querySelector('.pc-full')), shortVis: vis(chip.querySelector('.pc-short')),
        merchant: chip.dataset.merchant,
      };
    });
    const wide = await probe();
    check('at 1400px wide the full names still show (name and pinned chip)', wide.after === 'none' && wide.full && !wide.shortVis && wide.width > 80, JSON.stringify(wide));
    await sp.setViewportSize({ width: 1250, height: 900 });
    check('…and at 1250px', (await probe()).after === 'none');
    await sp.setViewportSize({ width: 1249, height: 900 });
    await sp.waitForTimeout(200);
    const narrow = await probe();
    check('below 1250px the shipment name shows its shorthand', narrow.after === '"BSV"' && narrow.short === 'BSV' && narrow.width < 60, JSON.stringify(narrow));
    check('…and so does the pinned-merchant chip', !narrow.full && narrow.shortVis, JSON.stringify(narrow));
    check('…while the real name and Inventory/filter linkage are untouched', narrow.text === 'Blue Sky Vitamin' && narrow.merchant === 'Blue Sky Vitamin');
    check('…and an order without a shorthand keeps its full name', narrow.otherShort === undefined && narrow.otherText === 'Other Co');
    await sp.locator('.shipment[data-id="o_bs"] .ship-name').click();
    check('…editing the name brings the full text back', (await probe()).after === 'none');
    await sp.keyboard.press('Tab');
    await sp.reload({ waitUntil: 'load' });
    await sp.waitForSelector('.shipment[data-id="o_bs"]', { state: 'attached', timeout: 15000 });
    await sp.waitForTimeout(500);
    check('the shorthand persists across a reload', (await probe()).short === 'BSV');
    await sp.setViewportSize({ width: 390, height: 800 });
    await sp.waitForTimeout(300);
    check('…and applies on a phone too', (await sp.evaluate(() => getComputedStyle(document.querySelector('.shipment[data-id="o_bs"] .ship-name'), '::after').content)) === '"BSV"');
    await sp.setViewportSize({ width: 1400, height: 900 });
    await sp.evaluate(() => document.getElementById('config-shorthand').click());
    await sp.waitForSelector('#shorthand-overlay .sh-row .sh-del', { state: 'visible' });
    await sp.locator('#shorthand-overlay .sh-del').click();
    await sp.waitForTimeout(400);
    check('removing a pair clears it everywhere', shPosts.some((p) => p.action === 'shorthand-clear' && p.name === 'Blue Sky Vitamin') && (await probe()).short === undefined && (await sp.locator('#shorthand-overlay .sh-row').count()) === 0);
    await sp.keyboard.press('Escape'); // close the shorthand modal
    // the pinned-merchant chip matches the other header controls, and the × clears its filter too
    const chipBox = await sp.evaluate(() => { const c = document.querySelector('#pinned-merchants-desktop .pin-chip'), r = c.getBoundingClientRect(), cs = getComputedStyle(c); return [Math.round(r.height * 10) / 10, cs.borderRadius, cs.borderTopWidth]; });
    check('a pinned-merchant chip is also 30px tall with a 7px radius', chipBox[0] === 30 && chipBox[1] === '7px' && chipBox[2] === '1px', JSON.stringify(chipBox));
    check('the × starts disabled', await sp.locator('#global-search-clear').isDisabled());
    await sp.locator('#pinned-merchants-desktop .pin-chip').click();
    await sp.waitForTimeout(300);
    check('a pinned merchant filter enables the ×', !(await sp.locator('#global-search-clear').isDisabled()) && (await sp.locator('#pinned-merchants-desktop .pin-chip').evaluate((e) => e.classList.contains('active'))));
    await sp.locator('#global-search-clear').click();
    await sp.waitForTimeout(300);
    check('…and clicking the × clears it (chip deselected, × disabled again)', !(await sp.locator('#pinned-merchants-desktop .pin-chip').evaluate((e) => e.classList.contains('active'))) && (await sp.locator('#global-search-clear').isDisabled()));
    await sc.close();
  }

  // ── a big board (~1,000 cards): filter buttons stay snappy, and jumping to a deep order still lands right ──
  {
    const bc = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
    const bp = await bc.newPage();
    const bMonths = [], bOrders = [], bItems = [], bInv = [], bLog = [];
    let bn = 0;
    for (let mi = 0; mi < 12; mi++) {
      const m = monthAt(mi);
      bMonths.push({ month: m.month, year: m.year, position: mi + 1 });
      for (let k = 0; k < 14; k++) {
        const oid = 'bo_' + mi + '_' + k;
        bOrders.push({ order_id: oid, month: m.month, year: m.year, merchant: 'Merchant ' + k, position: k + 1, status: 'Staged', notes: null });
        for (let j = 0; j < 6; j++) {
          bn++;
          bItems.push(card('bi_' + bn, oid, m, k + 1, j + 1, 'Item ' + ((k * 6 + j) % 70), j % 2 ? { autoship_next_date: iso(plusDays(mi * 30 + j * 3)), autoship_link: 'https://x.test/' + bn } : {}));
        }
      }
    }
    for (let q = 0; q < 70; q++) {
      bInv.push({ id: 100 + q, name: 'Item ' + q, bottle_size: 60, daily_dose: 1 });
      bLog.push({ id: 100 + q, item: 'Item ' + q, type: 'Reset', amount: 20 + q * 5, logged_on: iso(now), order_id: null });
    }
    const jr = (r, obj) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
    await bp.route('**/api/orders', (r) => (r.request().method() === 'GET' ? jr(r, { months: bMonths, orders: bOrders, items: bItems }) : jr(r, { ok: true })));
    await bp.route('**/api/inventory-items', (r) => jr(r, bInv));
    await bp.route((u) => new URL(u).pathname === '/api/inventory', (r) => jr(r, r.request().method() === 'GET' ? bLog : { ok: true }));
    await bp.goto(base, { waitUntil: 'load' });
    await bp.waitForSelector('#tab-board #board .shipment', { state: 'attached', timeout: 20000 });
    await bp.waitForTimeout(2000);
    check('big board: off-screen shipments are not laid out (content-visibility)', await bp.evaluate(() => getComputedStyle(document.querySelector('#board .shipment')).contentVisibility === 'auto'));
    const firstOpen = await bp.evaluate(async () => {
      document.getElementById('inv-search-link').click();
      const sp = document.querySelector('.inv-spinner');
      const out = { rows: document.querySelectorAll('#inv-body tr[data-key]').length, spinner: !!sp && sp.offsetParent !== null };
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return out;
    });
    check('big board: the FIRST Inventory open (a couple of seconds after load) shows the full list at once -- no spinner', firstOpen.rows >= 70 && !firstOpen.spinner, JSON.stringify(firstOpen));
    await bp.locator('#inv-modal-close').click();
    await bp.waitForTimeout(250);
    const paintMs = () => bp.evaluate(async () => { const el = document.getElementById('inv-autoship-btn'); const t0 = performance.now(); el.click(); await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); return performance.now() - t0; });
    await paintMs(); await paintMs(); // warm up
    const onMs = await paintMs(), offMs = await paintMs();
    check('big board: a filter button click paints in well under a second', Math.max(onMs, offMs) < 600, `on ${Math.round(onMs)}ms / off ${Math.round(offMs)}ms`);
    // jump (Inventory > Next Order) to a card well down its month: it must end up centred on screen
    await bp.locator('#inv-search-link').click();
    await bp.waitForSelector('#inv-body .inv-next-order.inv-clickable', { timeout: 10000 });
    const deepId = await bp.evaluate(() => {
      const found = [];
      document.querySelectorAll('#inv-body .inv-next-order.inv-clickable[data-card-id]').forEach((td) => {
        const c = document.querySelector('.card[data-id="' + td.dataset.cardId + '"]');
        if (!c) return;
        const mo = c.closest('.month');
        found.push({ id: td.dataset.cardId, rel: (c.getBoundingClientRect().top - mo.getBoundingClientRect().top) / mo.getBoundingClientRect().height });
      });
      found.sort((a, b) => Math.abs(a.rel - 0.6) - Math.abs(b.rel - 0.6));
      return found[0] && found[0].id;
    });
    await bp.evaluate((id) => document.querySelector('#inv-body .inv-next-order[data-card-id="' + id + '"]').click(), deepId);
    await bp.waitForTimeout(1600);
    const deepJump = await bp.evaluate((id) => { const c = document.querySelector('.card[data-id="' + id + '"]').getBoundingClientRect(), s = document.getElementById('tab-board').getBoundingClientRect(); return { off: Math.round((c.top + c.height / 2) - (s.top + s.height / 2)), h: Math.round(s.height) }; }, deepId);
    check('big board: jumping to a deep order (Inventory > Next Order) centres it on screen', Math.abs(deepJump.off) < 90, JSON.stringify({ deepId, deepJump }));
    await bc.close();
  }

  // ── touch screens: taps leave nothing "hot"; Inventory rides up as a sheet and eases back down ──
  {
    const openTouch = async (viewport, extra = {}) => {
      const c = await browser.newContext({ viewport, hasTouch: true, ...extra });
      const p = await c.newPage();
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.goto(base, { waitUntil: 'load' });
      await p.waitForSelector('#tab-board #board .month', { state: 'attached', timeout: 15000 });
      await p.waitForTimeout(1500);
      return { c, p };
    };
    const { c: tc, p: tp } = await openTouch({ width: 390, height: 800 }, { isMobile: true });
    const hot = (sel) => tp.evaluate((q) => ({ border: getComputedStyle(document.querySelector(q)).borderTopColor, focused: document.activeElement === document.querySelector(q) }), sel);
    check('(touch emulation is on: the device reports no hover)', await tp.evaluate(() => matchMedia('(hover: none)').matches));
    const gearBase = await hot('#settings-btn');
    await tp.tap('#settings-btn');
    await tp.waitForTimeout(150);
    const gearAfter = await hot('#settings-btn');
    check('tapping Settings opens it, and the gear does not stay teal or focused', (await tp.evaluate(() => document.getElementById('settings-panel').classList.contains('open'))) && gearAfter.border === gearBase.border && !gearAfter.focused, JSON.stringify({ gearBase, gearAfter }));
    await tp.tap('#settings-btn'); // close it again
    const autoBase = await hot('#inv-autoship-btn');
    await tp.tap('#inv-autoship-btn');
    await tp.waitForTimeout(250);
    const autoOn = await hot('#inv-autoship-btn');
    check('tapping Autoship filters, and the button does not stay focused', (await tp.evaluate(() => document.getElementById('inv-autoship-btn').classList.contains('active'))) && !autoOn.focused, JSON.stringify(autoOn));
    await tp.tap('#inv-autoship-btn');
    await tp.waitForTimeout(250);
    const autoOff = await hot('#inv-autoship-btn');
    check('…and once it is switched off it is back to its normal outline (no sticky hover teal)', autoOff.border === autoBase.border && !autoOff.focused, JSON.stringify({ autoBase, autoOff }));
    // Inventory: a sheet that rides up from the bottom...
    await tp.tap('#inv-search-link');
    const sheetIn = await tp.evaluate(() => getComputedStyle(document.getElementById('tab-inventory')).animationName);
    await tp.waitForTimeout(700);
    const sheetRest = await tp.evaluate(() => { const r = document.getElementById('tab-inventory').getBoundingClientRect(); return { top: Math.round(r.top), transform: getComputedStyle(document.getElementById('tab-inventory')).transform }; });
    check('on a phone the Inventory window eases up from the bottom as it opens, then rests flush', sheetIn === 'np-sheet-in' && sheetRest.top === 0 && sheetRest.transform === 'none', JSON.stringify({ sheetIn, sheetRest }));
    // ...and eases back down when closed
    await tp.tap('#inv-modal-close');
    await tp.waitForTimeout(60);
    const closing = await tp.evaluate(() => ({ cls: document.getElementById('inv-modal-ov').className, anim: getComputedStyle(document.getElementById('tab-inventory')).animationName, shown: getComputedStyle(document.getElementById('inv-modal-ov')).display }));
    check('closing it plays an ease-out first (the window is still up while it slides away)', /closing/.test(closing.cls) && closing.anim === 'np-sheet-out' && closing.shown === 'flex', JSON.stringify(closing));
    await tp.waitForTimeout(600);
    const closed = await tp.evaluate(() => ({ cls: document.getElementById('inv-modal-ov').className, shown: getComputedStyle(document.getElementById('inv-modal-ov')).display }));
    check('…and then it is gone', !/open|closing/.test(closed.cls) && closed.shown === 'none', JSON.stringify(closed));
    await tp.tap('#inv-search-link'); // reopening works after a close
    await tp.waitForTimeout(500);
    check('…and it reopens normally afterwards', await tp.evaluate(() => document.getElementById('inv-modal-ov').classList.contains('open') && !document.getElementById('inv-modal-ov').classList.contains('closing')));
    await tc.close();

    // touch tablet: no hover to reveal the row delete buttons, so they are simply there
    const { c: ic, p: ip } = await openTouch({ width: 1024, height: 768 });
    await ip.evaluate(() => document.getElementById('inv-search-link').click());
    await ip.waitForSelector('#inv-body .inv-del-btn', { state: 'attached', timeout: 10000 });
    check('on a touch tablet the Inventory row delete buttons are visible without hovering', (await ip.evaluate(() => Number(getComputedStyle(document.querySelector('#inv-body .inv-del-btn')).opacity))) >= 0.5);
    await ic.close();

    // desktop: hovering still lights things up, and closing eases out too
    const dc = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const dp = await dc.newPage();
    await dp.goto(base, { waitUntil: 'load' });
    await dp.waitForSelector('#tab-board #board .month', { state: 'attached', timeout: 15000 });
    await dp.waitForTimeout(1200);
    const dBase = await dp.evaluate(() => getComputedStyle(document.getElementById('settings-btn')).borderTopColor);
    await dp.hover('#settings-btn');
    await dp.waitForTimeout(300);
    const dHover = await dp.evaluate(() => getComputedStyle(document.getElementById('settings-btn')).borderTopColor);
    check('on a desktop, hovering the gear still turns its outline teal', dHover !== dBase, JSON.stringify({ dBase, dHover }));
    await dp.mouse.move(5, 500);
    await dp.click('#inv-search-link');
    await dp.waitForTimeout(450);
    await dp.click('#inv-modal-close');
    await dp.waitForTimeout(50);
    const dClosing = await dp.evaluate(() => ({ cls: document.getElementById('inv-modal-ov').className, anim: getComputedStyle(document.getElementById('tab-inventory')).animationName }));
    check('on a desktop the Inventory window also eases out when closed', /closing/.test(dClosing.cls) && dClosing.anim === 'np-pop-out', JSON.stringify(dClosing));
    await dp.waitForTimeout(500);
    check('…then it is gone', await dp.evaluate(() => !document.getElementById('inv-modal-ov').classList.contains('open')));
    await dc.close();
  }

  // ── mobile: panel renders and Approve is tappable ──
  const m = await openBoard({ width: 390, height: 800 });
  if (process.env.SHOT_DIR) await m.page.screenshot({ path: join(process.env.SHOT_DIR, 'warn-mobile.png') });
  if (process.env.SHOT_DIR) await m.page.locator('header').screenshot({ path: join(process.env.SHOT_DIR, 'header-mobile.png') });
  const boxW = () => m.page.locator('.global-search-box').evaluate((e) => e.getBoundingClientRect().width);
  const restW = await boxW();
  await m.page.locator('#global-search-input').focus();
  await m.page.waitForTimeout(200);
  check('mobile: focusing search gives it the room (the Autoship button steps aside)', (await boxW()) > restW + 60, `${restW} -> ${await boxW()}`);
  await m.page.locator('#global-search-input').blur();
  if (process.env.SHOT_DIR) await m.page.locator(`.month[data-id="${M1.month}_${M1.year}"]`).screenshot({ path: join(process.env.SHOT_DIR, 'preempt-mobile.png') });
  // mobile: ignore one, tap the chip -> the completed list fits the screen and Restore works
  await m.page.locator(`.month[data-id="${M0.month}_${M0.year}"] .month-warn [data-act="warn-ignore"]`).first().click();
  await m.page.waitForTimeout(200);
  const mChip = m.page.locator(`.month[data-id="${M0.month}_${M0.year}"] .warn-ign`);
  const mCount = async () => parseInt(await mChip.textContent(), 10);
  const mBefore = await mCount();
  await mChip.click();
  await m.page.waitForSelector('.warn-ign-pop .wip-row', { state: 'visible' });
  const popBox = await m.page.locator('.warn-ign-pop').boundingBox();
  check('mobile: tapping the chip opens the completed list, within the screen', popBox && popBox.x >= 0 && popBox.x + popBox.width <= 390 && popBox.y >= 0, JSON.stringify(popBox));
  check('mobile: each completed item is still one line', await m.page.evaluate(() => [...document.querySelectorAll('.warn-ign-pop .wip-row')].every((r) => r.getBoundingClientRect().height < 44)));
  if (process.env.SHOT_DIR) await m.page.screenshot({ path: join(process.env.SHOT_DIR, 'ign-pop-mobile.png') });
  await m.page.locator('.warn-ign-pop .wip-btn[data-kind="ignored"]').first().click();
  await m.page.waitForTimeout(250);
  check('mobile: Restore works (one fewer completed)', (await mCount()) === mBefore - 1, `${mBefore} -> ${await mCount()}`);
  check('mobile: panel renders', (await m.page.locator('.month-warn:not([hidden]) .warn-row').count()) > 0);
  const mBtn = m.page.locator(`.month[data-id="${M0.month}_${M0.year}"] .month-warn [data-act="warn-approve"]`).first();
  const mBox = await mBtn.boundingBox();
  check('mobile: Approve button within viewport width', mBox && mBox.x >= 0 && mBox.x + mBox.width <= 390, JSON.stringify(mBox));
  // (the mobile board now scrolls its MONTHS sideways by design, so the whole pane can't be asserted not to --
  //  what matters is that the panel itself fits inside its own month column)
  check('mobile: the Needs Attention box and its rows fit inside their month column (no sideways overflow)', await m.page.evaluate((id) => {
    const box = document.querySelector('.month[data-id="' + id + '"] > .month-list > .month-warn');
    const col = box.closest('.month').getBoundingClientRect();
    const rows = [...box.querySelectorAll('.warn-row, .warn-btn')];
    return box.scrollWidth <= box.clientWidth + 1 && rows.every((e) => e.getBoundingClientRect().right <= col.right + 1);
  }, M0.month + '_' + M0.year));
  const mfab = await m.page.evaluate(() => { const b = document.getElementById('inv-search-link'), r = b.getBoundingClientRect(); return { radius: getComputedStyle(b).borderRadius, right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), w: Math.round(r.width) }; });
  check('mobile: the round Inventory button sits bottom-right', mfab.radius === '50%' && mfab.w === 52 && mfab.right === 16 && mfab.bottom === 24, JSON.stringify(mfab));
  await m.page.locator('#inv-search-link').click();
  await m.page.waitForSelector('#inv-modal-ov.open');
  await m.page.waitForSelector('#inv-cards .inv-card', { timeout: 10000 });
  const mhead = await m.page.evaluate(() => { const sc = document.getElementById('inv-scan-btn'), cl = document.getElementById('inv-modal-close'), a = sc.getBoundingClientRect(), b = cl.getBoundingClientRect(); return { visible: a.width > 0, nextIsClose: sc.nextElementSibling === cl, gap: Math.round(b.left - a.right), sameRow: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 2, rightEdge: Math.round(innerWidth - b.right) }; });
  check('mobile: Scan sits in the Inventory window header, left of the close button', mhead.visible && mhead.nextIsClose && mhead.sameRow && mhead.gap >= 0 && mhead.gap <= 16 && mhead.rightEdge < 24, JSON.stringify(mhead));
  const msx = await m.page.evaluate(() => { const body = document.querySelector('.inv-modal-body'), modal = document.getElementById('tab-inventory'); body.scrollLeft = 120; const cs = getComputedStyle(body); return { ox: cs.overflowX, ta: cs.touchAction, modalTa: getComputedStyle(modal).touchAction, left: body.scrollLeft, over: body.scrollWidth - body.clientWidth, docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
  check('mobile: the Inventory window only scrolls vertically (no sideways scroll or pan)', msx.ox === 'hidden' && /pan-y/.test(msx.ta) && /pan-y/.test(msx.modalTa) && msx.left === 0 && msx.over <= 0, JSON.stringify(msx));
  await m.page.locator('#inv-modal-close').click();
  await m.page.waitForTimeout(200);
  await m.ctx.close();

  // ── a lapsed Cloudflare Access sign-in must not look like "server down" ──
  // (localhost has no Access in front, so use a fake non-local hostname mapped to this server)
  const b2 = await chromium.launch({ args: ['--host-resolver-rules=MAP np.test 127.0.0.1'] });
  try {
    const host = `http://np.test:${server.address().port}`;
    // (1) page load while /api/orders is unreachable -- what a lapsed sign-in looks like to fetch(): ONE reload (to reach the login page), no loop
    const c1 = await b2.newContext({ viewport: { width: 1400, height: 900 } });
    const p1 = await c1.newPage();
    let gets = 0;
    await p1.route('**/api/orders', (r) => { if (r.request().method() === 'GET') { gets++; return r.abort(); } return r.continue(); });
    await p1.goto(host, { waitUntil: 'load' });
    await p1.waitForFunction(() => /Could not reach the board API/.test(document.getElementById('board')?.textContent || ''), null, { timeout: 15000 });
    check('lapsed sign-in on page load: reloads ONCE to reach the login page, then stops (no reload loop)', gets === 2, String(gets));
    await c1.close();
    // (2) a save that fails (sign-in lapsed mid-session) says so instead of failing silently -- and does not reload away the edit
    const c2 = await b2.newContext({ viewport: { width: 1400, height: 900 } });
    const p2 = await c2.newPage();
    await p2.route('**/api/orders', (r) => (r.request().method() === 'PUT' ? r.abort() : r.continue()));
    await p2.goto(host, { waitUntil: 'load' });
    await p2.waitForSelector('#tab-board #board .shipment', { state: 'attached', timeout: 15000 });
    await p2.evaluate(() => document.querySelector('.shipment:not(.is-locked) .card:not(.card--ghost):not(.card--divider) .incl-toggle:not([disabled])').click());
    await p2.waitForFunction(() => getComputedStyle(document.getElementById('sync-banner')).display !== 'none', null, { timeout: 10000 });
    const msg = await p2.locator('#sync-banner .sync-banner-msg').textContent();
    check('a failed save shows a "sign-in expired / offline" banner with a Refresh button', /sign-in expired/.test(msg) && (await p2.locator('#sync-banner-refresh').isVisible()), msg);
    check('…and does not reload the page out from under the unsaved edit', await p2.evaluate(() => !!document.querySelector('.shipment .card')));
    await c2.close();
    // (2b) an On Hand edit late in the evening logs TODAY (local), not the UTC date, which is already tomorrow
    const c4 = await b2.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: 'America/New_York' });
    const p4 = await c4.newPage();
    await p4.clock.setFixedTime(new Date('2026-10-24T23:30:00-04:00')); // = 2026-10-25T03:30Z
    let resetBody = null;
    await p4.route('**/api/inventory', (r) => { if (r.request().method() === 'POST') { resetBody = JSON.parse(r.request().postData() || '{}'); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); } return r.continue(); });
    await p4.goto(host, { waitUntil: 'load' });
    await p4.waitForSelector('#tab-board #board .month', { state: 'attached', timeout: 15000 });
    await p4.locator('#inv-search-link').click();
    await p4.waitForSelector('#inv-body tr[data-key="runner"]');
    await p4.locator('#inv-body tr[data-key="runner"] .inv-onhand').click();
    await p4.locator('#inv-body tr[data-key="runner"] input').fill('30');
    await p4.keyboard.press('Enter');
    await p4.waitForTimeout(800);
    check('an evening On Hand edit logs the LOCAL date (10/24), not tomorrow\'s UTC date', resetBody && resetBody.logged_on === '2026-10-24', JSON.stringify(resetBody));
    await c4.close();
    // (3) on localhost nothing changes: the dev-server message stays, and there's no reload
    const c3 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const p3 = await c3.newPage();
    let localGets = 0;
    await p3.route('**/api/orders', (r) => { if (r.request().method() === 'GET') { localGets++; return r.abort(); } return r.continue(); });
    await p3.goto(base, { waitUntil: 'load' });
    await p3.waitForFunction(() => /dev server running/.test(document.getElementById('board')?.textContent || ''), null, { timeout: 15000 });
    await p3.waitForTimeout(500);
    check('on localhost an unreachable API still shows the dev-server message, with no reload', localGets === 1, String(localGets));
    await c3.close();
  } finally {
    await b2.close();
  }
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
