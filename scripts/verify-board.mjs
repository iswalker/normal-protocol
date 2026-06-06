/* ───────────────────────────────────────────────────────────────────────
   verify-board.mjs — headless smoke test for the Supplement Board tab.

   Serves the project over a tiny static server (no wrangler / no Turso needed —
   the board is pure localStorage) and drives it with Playwright Chromium:
     • the board renders 3 month columns
     • June roll-up metrics are correct
     • ATP reads SOON, and toggling Serratia moves its $ in/out of the
       Blue Sky shipment subtotal (and the month Shipments metric)
     • a card can be dragged between shipments (best-effort)
   Writes a screenshot to scripts/board-screenshot.png for eyeballing.

   Run:  npm run verify        (after `npm install` + `npx playwright install chromium`)
   ─────────────────────────────────────────────────────────────────────── */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.ico': 'image/x-icon', '.png': 'image/png',
};

// ── tiny static server; /api/* returns a stub so the Intakes fetch fails fast ──
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":"stub — no backend in verify"}');
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

const checks = [];
const check = (name, cond, detail = '') =>
  checks.push({ name, ok: !!cond, detail });

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(base, { waitUntil: 'load' });

  // open the board tab
  await page.click('.tab-btn[data-tab="board"]');
  await page.waitForSelector('#tab-board.active #board .month', { timeout: 5000 });
  await page.waitForFunction(() => document.fonts && document.fonts.status === 'loaded').catch(() => {});
  await page.waitForTimeout(300); // let recalc settle

  const months = page.locator('#board .month');
  check('renders 3 month columns', (await months.count()) === 3,
    `found ${await months.count()}`);

  const june = months.nth(0);
  const txt = (loc) => loc.innerText();

  const shipv = await txt(june.locator('.shipv'));
  const plannedv = await txt(june.locator('.plannedv'));
  const maxv = await txt(june.locator('.maxv'));
  const spent = await june.locator('.spent-input').inputValue();
  check('June Spent input = 480', spent === '480', `got ${spent}`);
  check('June Shipments = $244.00 (Serratia off)', shipv === '$244.00', `got ${shipv}`);
  check('June Planned = $760.00', plannedv === '$760.00', `got ${plannedv}`);
  check('June Max = $814.00', maxv === '$814.00', `got ${maxv}`);

  // Blue Sky is June's first shipment; subtotal excludes the toggled-off Serratia
  const blueSky = june.locator('.shipment').nth(0);
  const blueSkySub = await txt(blueSky.locator('.ship-total .amt'));
  check('Blue Sky subtotal = $148.00 (Serratia off)', blueSkySub === '$148.00', `got ${blueSkySub}`);

  // ATP is Blue Sky's first card → SOON
  const atp = blueSky.locator('.card').nth(0);
  const atpStatus = await txt(atp.locator('.status'));
  check('ATP card tier = SOON', atpStatus === 'SOON' && (await atp.getAttribute('class')).includes('tier-soon'),
    `status=${atpStatus}`);

  // toggle Serratia ON → it re-enters Blue Sky subtotal + month metrics
  const serratia = blueSky.locator('.card').nth(3); // atp, drainage, para2, serratia
  await serratia.locator('.incl-toggle').click();
  await page.waitForTimeout(150);
  const blueSkySub2 = await txt(blueSky.locator('.ship-total .amt'));
  const shipv2 = await txt(june.locator('.shipv'));
  const plannedv2 = await txt(june.locator('.plannedv'));
  check('toggling Serratia ON → Blue Sky subtotal $202.00', blueSkySub2 === '$202.00', `got ${blueSkySub2}`);
  check('toggling Serratia ON → June Shipments $298.00', shipv2 === '$298.00', `got ${shipv2}`);
  check('toggling Serratia ON → June Planned $814.00', plannedv2 === '$814.00', `got ${plannedv2}`);
  // revert
  await serratia.locator('.incl-toggle').click();
  await page.waitForTimeout(100);

  // drag: move LymphActiv (loose card) into Blue Sky shipment.
  // SortableJS forceFallback needs a real stepped pointer gesture: press on the
  // grip, nudge past the drag threshold, then several moves onto the target.
  try {
    const before = await blueSky.locator('.ship-body > .card').count();
    const loose = june.locator('.month-list > .card').first();
    const grip = loose.locator('.card-grip');
    await grip.hover();
    const g = await grip.boundingBox();
    const body = await blueSky.locator('.ship-body').boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 6); // cross threshold
    const tx = body.x + body.width / 2;
    const ty = body.y + body.height / 2;
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(g.x + (tx - g.x) * (i / 10), g.y + (ty - g.y) * (i / 10));
      await page.waitForTimeout(20);
    }
    await page.mouse.move(tx, ty);
    await page.waitForTimeout(60);
    await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await blueSky.locator('.ship-body > .card').count();
    check('drag: LymphActiv moved into Blue Sky shipment', after === before + 1,
      `Blue Sky cards ${before} → ${after}`);
  } catch (e) {
    check('drag', false, `drag threw: ${e.message}`);
  }

  check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  await page.screenshot({ path: join(ROOT, 'scripts', 'board-screenshot.png'), fullPage: true });
} finally {
  await browser.close();
  server.close();
}

// ── report ──
let failed = 0;
console.log('\nSupplement Board — verification\n' + '─'.repeat(40));
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  →  ${c.detail}`}`);
  if (!c.ok) failed++;
}
console.log('─'.repeat(40));
console.log(`${checks.length - failed}/${checks.length} passed`);
console.log('screenshot: scripts/board-screenshot.png');
process.exit(failed ? 1 : 0);
