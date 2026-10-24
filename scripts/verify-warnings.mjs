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
  const m0list = page.locator(`.month[data-id="${M0.month}_${M0.year}"] > .month-list`);
  const mirrorNames = () => m0list.locator('.month-preempt > .pre-host').evaluateAll((els) => els.map((e) => e.dataset.preName));
  const mnames = await mirrorNames();
  check('mirror: a preemptive next-month order appears in this month', mnames.includes('Pre Auto Co') && mnames.includes('Dup Co') && mnames.includes('Item Date Co'), mnames.join(', '));
  check('mirror: an ordinary next-month order does not', !mnames.includes('Normal Co'));
  check('mirror: sits at the bottom of the open orders (just above the completed ones)', await m0list.evaluate((l) => { const w = l.querySelector(':scope > .month-preempt'); const h = w && w.nextElementSibling; return !!w && !!h && h.classList.contains('month-done-head') && h.nextElementSibling.classList.contains('is-locked') && !w.previousElementSibling.classList.contains('is-locked'); }));
  check('mirror: invisible to the board (document-wide .shipment/.card/data-id queries never see it)', await page.evaluate(() => {
    const host = document.querySelector('.pre-host'); const root = host.shadowRoot;
    return !!root.querySelector('.shipment') && !host.querySelector('.shipment, .card') && ![...document.querySelectorAll('.shipment, .card')].some((e) => e.closest('.month-preempt'));
  }));
  // the FULL order structure: same header + every item with its fields, greyed like a completed order but expanded
  const full = await page.evaluate(() => {
    const host = [...document.querySelectorAll('.pre-host')].find((h) => h.dataset.preName === 'Pre Auto Co');
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
      readonly: [...sh.querySelectorAll('input')].every((i) => i.disabled) && sh.querySelectorAll('[contenteditable]').length === 0,
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
  const mirrorBg = (name) => page.evaluate((n) => getComputedStyle([...document.querySelectorAll('.pre-host')].find((h) => h.dataset.preName === n).shadowRoot.querySelector('.shipment')).backgroundColor, name);
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
    if (c.contains('shipment')) return c.contains('is-locked') ? 'locked' : (n.querySelector(':scope > .ship-head > .ship-preempt.is-on') ? 'pre' : 'std');
    return 'other';
  }), m1id);
  check('month layout: Preemptive / Needs Attention / In-Month / Preemptive-from-next / Completed', /^pre-head( pre)+ warn-head warn in-head( (std|other))+ mirror-head mirrors done-head( locked)+$/.test(seq.join(' ')), seq.join(' '));
  const heads = await page.evaluate((id) => Object.fromEntries(['pre-head', 'in-head', 'mirror-head', 'done-head'].map((k) => [k, document.querySelector('.month[data-id="' + id + '"] > .month-list > .month-' + k.replace('-head', '') + (k === 'mirror-head' ? '-head' : '-head'))?.textContent])), m1id);
  check('section headers read Preemptive Orders / In-Month Orders / Preemptive Orders · <next month> / Completed Orders', heads['pre-head'] === 'Preemptive Orders' && heads['in-head'] === 'In-Month Orders' && heads['mirror-head'] === 'Preemptive Orders · ' + M2.month && heads['done-head'] === 'Completed Orders', JSON.stringify(heads));
  check('the panel really is below the Preemptive group and above In-Month', seq.indexOf('warn') > seq.lastIndexOf('pre') && seq.indexOf('warn') < seq.indexOf('in-head'));
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

  check('mirror: shows the real order\'s full structure (header, every item, every field), expanded and greyed', Object.values(full).every(Boolean), JSON.stringify(full));
  const plannedBefore = await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .plannedv`).textContent();
  const countBefore = await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .mcount`).textContent();
  await pbtn('o_norm').click(); await page.waitForTimeout(700); // flag one more order -> one more mirror
  check('mirror: flagging another order adds its mirror', (await mirrorNames()).includes('Normal Co'));
  check('colour: a preview of a non-autoship order is the standard teal', (await mirrorBg('Normal Co')) === TEAL, await mirrorBg('Normal Co'));
  check('mirror: does not change the month metrics or count', (await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .plannedv`).textContent()) === plannedBefore && (await page.locator(`.month[data-id="${M0.month}_${M0.year}"] .mcount`).textContent()) === countBefore);
  const savedOrders = puts[puts.length - 1].orders.map((o) => o.order_id);
  check('mirror: never saved (no duplicate or extra orders)', new Set(savedOrders).size === savedOrders.length && savedOrders.length === (await page.evaluate(() => document.querySelectorAll('.shipment').length)), `${savedOrders.length}`);
  await page.locator('.pre-host[data-pre-name="Normal Co"]').click();
  await page.waitForTimeout(250);
  await page.waitForTimeout(900);
  const sJump = await clearOfHead(page, '.shipment[data-id="o_norm"]');
  check('jumping to an order lands just BELOW the sticky month header (not under it)', sJump.ok, JSON.stringify(sJump));
  check('mirror: has no caption line (the Preemptive button says it all)', await page.evaluate(() => [...document.querySelectorAll('.pre-host')].every((h) => !h.shadowRoot.querySelector('.pre-cap') && !/placed early/.test(h.shadowRoot.textContent))));
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
  await page.waitForTimeout(900); // let the smooth scroll settle
  const cJump = await clearOfHead(page, '.card[data-id="oi_later"]');
  check('jumping to an item lands just BELOW the sticky month header (not under it)', cJump.ok, JSON.stringify(cJump));
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
    return heads.map((h) => ({ first: h === list.firstElementChild, mt: getComputedStyle(h).marginTop })).filter((x) => x.first || x.mt === '4px');
  }), [M0.month + '_' + M0.year, M1.month + '_' + M1.year]);
  check('only the label that is really first in a month gets the 4px first-child margin', firstOnly.every((m) => m.length === 1 && m[0].first && m[0].mt === '4px'), JSON.stringify(firstOnly));
  check('other section labels keep the normal 8px top margin', await page.evaluate((id) => [...document.querySelectorAll('.month[data-id="' + id + '"] > .month-list > .month-sec-head')].filter((h) => h !== h.parentNode.firstElementChild).every((h) => getComputedStyle(h).marginTop === '8px'), M1.month + '_' + M1.year));
  check('the "n completed" chip has no border and the 1px 9px 2px 9px padding', await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.warn-ign')); return c.borderTopStyle === 'none' && c.paddingTop === '1px' && c.paddingRight === '9px' && c.paddingBottom === '2px' && c.paddingLeft === '9px'; }));
  check('the title label matches the other section labels (same size/weight/colour)', await page.evaluate((id) => {
    const q = (sel) => { const e = document.querySelector('.month[data-id="' + id + '"] ' + sel); const c = getComputedStyle(e); return [c.fontSize, c.fontWeight, c.color, c.textTransform].join('|'); };
    return q('.month-list > .month-warn-head') === q('.month-list > .month-in-head');
  }, M0.month + '_' + M0.year));
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
  await page.locator('#inv-body tr[data-key="runner"] .inv-onhand').click();
  await page.locator('#inv-body tr[data-key="runner"] input').fill('30');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const todayMD = `${now.getMonth() + 1}/${now.getDate()}`;
  check('after editing On Hand, Lasts For is still a day count (not the reset date)', /^\d+(\.\d)?d$/.test((await lasts()).trim()), await lasts());
  check('…and Last Reset got the date instead', (await page.locator('#inv-body tr[data-key="runner"] .inv-reset').textContent()).trim() === todayMD);
  await page.locator('#inv-modal-close').click();
  await page.waitForTimeout(200);

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
