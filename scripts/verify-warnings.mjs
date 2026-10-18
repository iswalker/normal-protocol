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
    card('oi_covered', null, M0, 5, 1, 'Covered', {}),
  ],
};
const INV_ITEMS = [
  { id: 1, name: 'Runner', bottle_size: 60, daily_dose: 1 },
  { id: 2, name: 'Covered', bottle_size: 60, daily_dose: 1 },
  { id: 3, name: 'Plenty', bottle_size: 60, daily_dose: 1 },
  { id: 4, name: 'Alpha', bottle_size: 60, daily_dose: 1 },
];
const INV_LOG = [
  { id: 1, item: 'Runner', type: 'Reset', amount: 2, logged_on: iso(now), order_id: null },
  { id: 2, item: 'Covered', type: 'Reset', amount: 2, logged_on: iso(now), order_id: null },
  { id: 3, item: 'Plenty', type: 'Reset', amount: 400, logged_on: iso(now), order_id: null },
  { id: 4, item: 'Alpha', type: 'Reset', amount: 400, logged_on: iso(now), order_id: null },
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
  await page.waitForSelector('.month-warn .warn-tag.is-runout', { timeout: 10000 });
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
  const later = await rowFor(page, 'Later Placement').locator('.warn-detail').textContent();
  check('later-placed row says which month it sits in', later.includes(M2.month), later);
  check('overdue row is flagged', (await rowFor(page, 'Overdue One').locator('.warn-detail').textContent()).startsWith('Overdue'));
  check('panel shows a count badge', (await panel(page).locator('.warn-count').textContent()).trim() === String(names.length), String(names.length));
  // past months get no panel; the panel lives outside .month-list
  check('panel is outside .month-list', (await page.locator('.month-list .month-warn').count()) === 0);

  // ── dates: m/d like the board, clickable when there's a link ──
  const alphaRow = rowFor(page, 'Alpha');
  const dateTxt = (await alphaRow.locator('.warn-date').textContent()).trim();
  const boardTxt = (await page.locator('.card[data-id="oi_alpha"] .autoship-date, .card[data-id="oi_alpha"] .autoship-date-badge').locator('visible=true').first().textContent()).trim();
  check('panel date matches the board card date format', dateTxt === boardTxt && /^\d+\/\d+/.test(dateTxt), `${dateTxt} vs ${boardTxt}`);
  check('run-out date also uses m/d', /^\d+\/\d+/.test((await rowFor(page, 'Runner').locator('.warn-detail').textContent()).trim()));
  check('date without a link is plain text', (await rowFor(page, 'Stale Approval').locator('.warn-date').count()) === 0);
  await ctx.route('https://example.com/**', (r) => r.fulfill({ body: 'ok', contentType: 'text/html' }));
  const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 5000 }).catch(() => null), alphaRow.locator('.warn-date').click()]);
  check('clicking the date opens the Autoship link', popup && popup.url().startsWith('https://example.com/alpha'), popup ? popup.url() : 'no popup');
  await popup?.close();

  // ── run-out Ignore / restore ──
  await rowFor(page, 'Runner').locator('[data-act="warn-ignore"]').click();
  await page.waitForTimeout(150);
  check('Ignore removes the run-out row', !(await rowNames(page)).includes('Runner'));
  check('Ignore posts a dismiss with a month-scoped key', posts.some((b) => b.action === 'dismiss' && b.key === `runout|runner|${ym0}`), JSON.stringify(posts));
  check('ignored count + restore link shown', /1 ignored/.test(await panel(page).locator('.warn-restore').textContent()));
  await panel(page).locator('[data-act="warn-restore"]').click();
  await page.waitForTimeout(150);
  check('Restore brings the row back', (await rowNames(page)).includes('Runner'));
  check('Restore posts an undismiss', posts.some((b) => b.action === 'undismiss' && b.key === `runout|runner|${ym0}`));
  // …and a reload keeps an ignore (server-side state), but only for THIS month's key
  await rowFor(page, 'Runner').locator('[data-act="warn-ignore"]').click();
  await page.waitForTimeout(150);
  await page.reload();
  await page.waitForSelector('#tab-board #board .month');
  await page.waitForFunction(() => window._INV_ITEM_MAP && document.querySelector('.month-warn .warn-tag.is-autoship'), null, { timeout: 10000 });
  await page.waitForTimeout(500);
  check('ignore survives a reload', !(await rowNames(page)).includes('Runner'));
  await panel(page).locator('[data-act="warn-restore"]').click(); // leave the mock clean
  await page.waitForTimeout(150);

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
  await page.evaluate(() => window.SupplementBoard.saveCardAutoship('oi_approved', '', new Date(Date.now() + 86400000).toISOString().slice(0, 10)));
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
  check('lifecycle: completed occurrence no longer warns', !(await rowNames(page)).includes('Ghosty'));
  const m1Names = await page.locator(`.month[data-id="${M1.month}_${M1.year}"] .month-warn .warn-name`).allTextContents();
  check('lifecycle: next month now asks for the fresh approval', m1Names.includes('Ghosty'), m1Names.join(', '));
  check('lifecycle: pre-advance projected ghosts never produced rows before', oldRoot && oldRoot.autoship_approved === iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2)));

  // ── nothing leaks into past/other structure ──
  check('no JS errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // ── mobile: panel renders and Approve is tappable ──
  const m = await openBoard({ width: 390, height: 800 });
  if (process.env.SHOT_DIR) await m.page.screenshot({ path: join(process.env.SHOT_DIR, 'warn-mobile.png') });
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
