/* verify-orders-integration.mjs — end-to-end: board UI <-> /api/orders <-> Turso.
   Serves the app and delegates /api/orders to the REAL function handlers
   (functions/api/orders.js) against the live Turso DB (.dev.vars). Then drives
   the board with Playwright: confirms it loads from Turso, shows "—" run-out
   (no Inventory yet), and that a toggle persists back to Turso. Restores after.

   Run:  node scripts/verify-orders-integration.mjs */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { onRequestGet, onRequestPut } from '../functions/api/orders.js';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const env = {};
for (const line of (await readFile(join(ROOT, '.dev.vars'), 'utf8')).split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2];
}
const apiGet = async () => (await onRequestGet({ env })).json();
const apiPut = async (body) => (await onRequestPut({ request: { json: async () => body }, env })).json();

const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon','.png':'image/png' };
const original = await apiGet(); // snapshot to restore later

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/orders') {
      let r;
      if (req.method === 'PUT') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        r = await onRequestPut({ request: { json: async () => body }, env });
      } else {
        r = await onRequestGet({ env });
      }
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(await r.text());
      return;
    }
    if (url.pathname.startsWith('/api/')) { res.writeHead(502); res.end('{}'); return; }
    let p = decodeURIComponent(url.pathname); if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});

const checks = []; const check = (n, ok, d='') => checks.push({ n, ok, d });
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));

try {
  await page.goto(base, { waitUntil: 'load' });
  await page.click('.tab-btn[data-tab="board"]');
  await page.waitForSelector('#tab-board.active #board .month', { timeout: 5000 });
  await page.waitForTimeout(400);

  const months = page.locator('#board .month');
  check('board loaded 3 months from Turso', (await months.count()) === 3, `got ${await months.count()}`);
  const june = months.nth(0);
  check('Jun name from Turso = "Jun"', (await june.locator('.mname').innerText()).trim() === 'Jun');
  // Spent is now YNAB-derived (not persisted); shows $0.00 without a live YNAB token
  check('Jun Spent=$0.00 (YNAB not connected)', (await june.locator('.spentv').innerText()) === '$0.00', await june.locator('.spentv').innerText());
  check('Jun Shipments=$244.00', (await june.locator('.shipv').innerText()) === '$244.00', await june.locator('.shipv').innerText());
  check('Jun Planned=$280.00 (0 spent + toggle-ON items)', (await june.locator('.plannedv').innerText()) === '$280.00', await june.locator('.plannedv').innerText());
  check('Jun Max=$334.00 (0 spent + all items)', (await june.locator('.maxv').innerText()) === '$334.00', await june.locator('.maxv').innerText());

  const blueSky = june.locator('.shipment').nth(0);
  const atp = blueSky.locator('.card').nth(0);
  check('ATP run-out shows "—" (no Inventory yet)', (await atp.locator('.runout .now').innerText()).trim() === '—',
    await atp.locator('.runout .now').innerText());
  check('ATP cost still $63.00 from Turso', (await atp.locator('.ototal .amt').innerText()) === '$63.00',
    await atp.locator('.ototal .amt').innerText());

  // toggle Serratia ON in the UI -> debounced PUT -> Turso
  const serratia = blueSky.locator('.card').nth(3);
  await serratia.locator('.incl-toggle').click();
  await page.waitForTimeout(900); // debounce(400) + network
  const afterDb = await apiGet();
  check('toggle persisted to Turso (serratia include=true)',
    afterDb.items.find((i) => i.order_item_id === 'oi_serratia')?.include_in_total === true);

  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  await page.screenshot({ path: join(ROOT, 'scripts', 'board-turso-screenshot.png'), fullPage: true });
} finally {
  await browser.close();
  await apiPut(original); // restore seed state
  const restored = await apiGet();
  check('restored serratia include=false', restored.items.find((i) => i.order_item_id === 'oi_serratia')?.include_in_total === false);
  server.close();
}

let fail = 0;
console.log('\nBoard <-> /api/orders <-> Turso\n' + '-'.repeat(36));
for (const c of checks) { console.log(`${c.ok?'PASS':'FAIL'}  ${c.n}${c.ok?'':'  -> '+c.d}`); if (!c.ok) fail++; }
console.log('-'.repeat(36)); console.log(`${checks.length - fail}/${checks.length} passed`);
process.exit(fail ? 1 : 0);
