/* ───────────────────────────────────────────────────────────────────────
   verify-recurrence.mjs — headless test for recurring ("ev N mo") series:
   changing the interval, ending a series, and the series-end note prefix.

   Fully offline: serves the repo statically and mocks EVERY /api/* endpoint
   in-process (nothing reaches Turso). The mock keeps a model of the database
   (PATCH bodies applied with board-model.mjs) and serves it back on GET, so
   a reload really reloads what was saved.

   Run:  node scripts/verify-recurrence.mjs
   ─────────────────────────────────────────────────────────────────────── */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { applyPatch, clone } from './board-model.mjs';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' };

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const now = new Date(); now.setHours(0, 0, 0, 0);
const monthAt = (off) => { const d = new Date(now.getFullYear(), now.getMonth() + off, 1); return { month: MON[d.getMonth()], year: d.getFullYear(), start: d }; };
const M0 = monthAt(0);
const monthId = (off) => { const m = monthAt(off); return `${m.month}_${m.year}`; };

// one recurring root ("Rooty", every 1 month) in the current month
const card = (id, order_id, m, bp, ip, name, extra = {}) => ({
  order_item_id: id, order_id, month: m.month, year: m.year, block_position: bp, item_position: ip,
  supplement: name, price_per_bottle: 10, order_qty_bottles: 1, include_in_total: true, notes: null, ...extra,
});
const FIXTURE = () => ({
  months: [monthAt(-1), M0, monthAt(1)].map((m, i) => ({ month: m.month, year: m.year, position: i + 1 })),
  orders: [{ order_id: 'o_root', month: M0.month, year: M0.year, merchant: 'Root Shop', position: 1, status: 'Staged', notes: null }],
  items: [card('oi_root', 'o_root', M0, 1, 1, 'Rooty', { recur: 1 })],
});

let serverBoard = FIXTURE();
const patches = [];
const meta = { at: '2000-01-01T00:00:00.000Z' };
const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {};
      if (p === '/api/orders') {
        if (req.method === 'PATCH') {
          patches.push(body); applyPatch(serverBoard, body);
          const prev = meta.at; meta.at = new Date().toISOString();
          return json(res, { ok: true, updated_at: meta.at, prev_updated_at: prev });
        }
        if (req.method === 'PUT') return json(res, { ok: true });
        return json(res, serverBoard);
      }
      if (p === '/api/board-settings') return json(res, req.method === 'GET' ? { pinnedMerchants: [], dismissedWarnings: [] } : { ok: true });
      if (p === '/api/inventory-items') return json(res, []);
      if (p === '/api/inventory') return json(res, []);
      if (p === '/api/meta') return json(res, { updated_at: meta.at });
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

async function openBoard() {
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { dialogs.push(d.message()); dialogAnswer ? d.accept() : d.dismiss(); });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#tab-board #board .month', { state: 'attached' });
  await page.waitForSelector('.card--ghost', { state: 'attached', timeout: 10000 });
  await page.waitForTimeout(400);
  return { ctx, page };
}
const dialogs = []; let dialogAnswer = true;
const settle = (page) => page.waitForTimeout(700);

// every card of the series, in month order: { id, month: offset from M0, ghost, ev (the "ev N mo" value shown), notes }
const series = (page, name = 'Rooty') => page.evaluate(({ name }) => {
  const months = [...document.querySelectorAll('#board > .month')];
  const out = [];
  months.forEach((m, mi) => {
    m.querySelectorAll('.card[data-id]').forEach((c) => {
      const n = c.querySelector('.card-name');
      if (!n || n.textContent.trim() !== name) return;
      out.push({
        id: c.dataset.id, mi, mid: m.dataset.id,
        ghost: c.classList.contains('card--ghost'),
        ev: c.querySelector('.recur-ctl-n').value,
        notes: c.querySelector('.card-notes').textContent,
      });
    });
  });
  return out;
}, { name });
const gaps = (cards) => cards.slice(1).map((c, i) => c.mi - cards[i].mi);
const setEv = async (page, id, v) => { await page.fill(`.card[data-id="${id}"] .recur-ctl-n`, String(v)); await settle(page); };
const dbItems = (name = 'Rooty') => serverBoard.items.filter((i) => i.supplement === name);

try {
  // ── 2. changing the interval ────────────────────────────────────────────
  {
    const { ctx, page } = await openBoard();
    let s = await series(page);
    check('starts as a monthly series (root + a ghost every month)', s.length > 5 && gaps(s).every((g) => g === 1), JSON.stringify(gaps(s)));

    await setEv(page, 'oi_root', 2);
    s = await series(page);
    check('1 → 2: ghosts move to every other month', gaps(s).every((g) => g === 2), JSON.stringify(gaps(s)));
    check('1 → 2: EVERY ghost now reads "ev 2 mo" (not the old 1)', s.every((c) => c.ev === '2'), JSON.stringify(s.map((c) => c.ev)));
    check('1 → 2: saved ghosts carry recur 2', dbItems().every((i) => Number(i.recur) === 2), JSON.stringify(dbItems().map((i) => i.recur)));

    // Place the root's order: the first ghost (a KEPT one, from the 1 → 2 edit) takes over as the root and must keep the interval.
    await page.evaluate(() => document.querySelector('.shipment[data-id="o_root"] [data-act="set-stage"][data-stage="ordered"]').click());
    await settle(page);
    s = await series(page);
    check('ordering the root: the series keeps its 2-month spacing', gaps(s).every((g) => g === 2) && s.length >= 3, JSON.stringify({ g: gaps(s), n: s.length }));
    check('ordering the root: the new root still says "ev 2 mo"', s.slice(1).every((c) => c.ev === '2'), JSON.stringify(s.map((c) => c.ev)));
    await ctx.close();
  }
  {
    serverBoard = FIXTURE(); patches.length = 0;
    const { ctx, page } = await openBoard();
    await setEv(page, 'oi_root', 2);
    await setEv(page, 'oi_root', 3);
    const s = await series(page);
    check('2 → 3: spacing and every ghost label follow', gaps(s).every((g) => g === 3) && s.every((c) => c.ev === '3'), JSON.stringify({ g: gaps(s), ev: s.map((c) => c.ev) }));
    await ctx.close();
  }

  // a stored series whose ghosts carry a stale interval (what the bug left behind) heals on load
  {
    serverBoard = FIXTURE();
    serverBoard.items[0].recur = 2;
    const pos = (n) => n;
    [2, 4].forEach((off, i) => {
      const m = monthAt(off); // ghosts at +2 and +4, but still labelled ev 1
      if (!serverBoard.months.find((x) => x.month === m.month && x.year === m.year)) serverBoard.months.push({ month: m.month, year: m.year, position: 10 + i });
      serverBoard.items.push(card(`g_stale${i}`, null, m, 1, 1, 'Rooty', { recur: 1, recur_source: 'oi_root' }));
    });
    patches.length = 0;
    const { ctx, page } = await openBoard();
    const s = await series(page);
    check('stale ghosts from an older edit heal on load (all read "ev 2 mo")', s.every((c) => c.ev === '2'), JSON.stringify(s.map((c) => c.ev)));
    await settle(page);
    check('…and the healed value is saved', dbItems().every((i) => Number(i.recur) === 2), JSON.stringify(dbItems().map((i) => i.recur)));
    await ctx.close();
  }
  // ── 1. ending a series by deleting a projection ─────────────────────────
  const lab = (off) => monthAt(off).month;
  const clickMenu = async (page, gripSel, label) => {
    await page.evaluate((sel) => document.querySelector(sel).click(), gripSel);
    await page.waitForSelector('.ship-ctx-menu');
    await page.evaluate((label) => [...document.querySelectorAll('.ship-ctx-menu .ship-ctx-item')].find((e) => e.textContent.trim() === label).click(), label);
    await settle(page);
  };
  const deleteGhostCard = (page, id) => clickMenu(page, `.card[data-id="${id}"] [data-act="open-card-menu"]`, 'Delete');
  const rootNotes = (page, id = 'oi_root') => page.evaluate((id) => document.querySelector(`.card[data-id="${id}"] .card-notes`).textContent, id);
  const blur = (page) => page.evaluate(() => document.activeElement && document.activeElement.blur());
  const fresh = async (mutate) => { serverBoard = FIXTURE(); if (mutate) mutate(serverBoard); patches.length = 0; dialogs.length = 0; dialogAnswer = true; return openBoard(); };

  {
    const { ctx, page } = await fresh();
    let s = await series(page);
    const total = s.length;
    const target = s[3];
    check('ghost menu offers Delete', await page.evaluate((id) => { document.querySelector(`.card[data-id="${id}"] [data-act="open-card-menu"]`).click(); const r = [...document.querySelectorAll('.ship-ctx-menu .ship-ctx-item')].some((e) => e.textContent.trim() === 'Delete'); return r; }, target.id));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);

    dialogAnswer = false;
    await deleteGhostCard(page, target.id);
    s = await series(page);
    check('cancelling the confirmation changes nothing', s.length === total && (await rootNotes(page)) === '' && dialogs.length === 1, JSON.stringify({ n: s.length, total, d: dialogs }));
    check('the confirmation says what will happen', /Delete "Rooty"/.test(dialogs[0]) && /recurring order/.test(dialogs[0]) && new RegExp(`end after ${lab(2)}`).test(dialogs[0]), dialogs[0]);

    dialogAnswer = true;
    await deleteGhostCard(page, target.id);
    s = await series(page);
    check('deleting a projection ends the series: root + the 2 months before it remain', s.length === 3 && gaps(s).every((g) => g === 1) && s[0].id === 'oi_root', JSON.stringify(s.map((c) => c.mi)));
    check('the root note says where it ends', (await rootNotes(page)) === `Ends after ${lab(2)}`, await rootNotes(page));
    check('the surviving projections carry the same note', s.slice(1).every((c) => c.notes === `Ends after ${lab(2)}`), JSON.stringify(s.map((c) => c.notes)));
    await settle(page);
    check('saved: nothing past the end, root note saved', dbItems().length === 3 && serverBoard.items.find((i) => i.order_item_id === 'oi_root').notes === `Ends after ${lab(2)}`, JSON.stringify({ n: dbItems().length }));
    await ctx.close();

    // a reload must not refill the gap / extend the series
    const again = await openBoard();
    const s2 = await series(again.page);
    check('after a reload the series is still cut short (no refill)', s2.length === 3, JSON.stringify(s2.map((c) => c.mi)));
    await again.ctx.close();
  }

  {
    // with a note already there: ".  " delimiter, original text kept
    const { ctx, page } = await fresh((b) => { b.items[0].notes = 'Buy in bulk'; });
    const s = await series(page);
    await deleteGhostCard(page, s[2].id);
    check('existing note: prefix + period + 2 spaces, text kept', (await rootNotes(page)) === `Ends after ${lab(1)}.  Buy in bulk`, JSON.stringify(await rootNotes(page)));

    // typing after the prefix is fine -- the series stays ended
    await page.click('.card[data-id="oi_root"] .card-notes');
    await page.keyboard.press('End');
    await page.keyboard.type(' Need to figure this one out');
    await blur(page); await settle(page);
    const s2 = await series(page);
    check('adding text after the prefix keeps the series ended', s2.length === 2 && (await rootNotes(page)).startsWith(`Ends after ${lab(1)}.  Buy in bulk`) && (await rootNotes(page)).endsWith('figure this one out'), JSON.stringify({ n: s2.length, notes: await rootNotes(page) }));

    // a second cut shortens it (replaces the prefix, doesn't stack)
    await deleteGhostCard(page, s2[1].id);
    check('cutting again replaces the prefix instead of stacking', (await rootNotes(page)).startsWith(`Ends after ${lab(0)}.  Buy in bulk`) && !/Ends after.*Ends after/.test(await rootNotes(page)), JSON.stringify(await rootNotes(page)));
    check('…and leaves only the root', (await series(page)).length === 1);
    await ctx.close();
  }

  {
    // removing the prefix puts the series back to indefinite
    const { ctx, page } = await fresh();
    let s = await series(page);
    const total = s.length;
    await deleteGhostCard(page, s[3].id);
    await page.click('.card[data-id="oi_root"] .card-notes');
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace');
    await blur(page); await settle(page);
    s = await series(page);
    check('deleting the "Ends after" prefix restores the indefinite series', s.length === total && gaps(s).every((g) => g === 1), JSON.stringify({ n: s.length, total }));
    check('…and the note is empty again on every card', s.every((c) => c.notes === ''), JSON.stringify(s.map((c) => c.notes)));
    await ctx.close();
  }

  {
    // retyping the prefix with a different month moves the end
    const { ctx, page } = await fresh();
    let s = await series(page);
    await deleteGhostCard(page, s[3].id); // ends after +2
    await page.click('.card[data-id="oi_root"] .card-notes');
    await page.keyboard.press('Control+A'); await page.keyboard.type(`Ends after ${lab(4)}`);
    await blur(page); await settle(page);
    s = await series(page);
    check('editing the prefix to a later month extends the series to it', s.length === 5 && s[4].mi - s[0].mi === 4, JSON.stringify(s.map((c) => c.mi)));
    await page.click('.card[data-id="oi_root"] .card-notes');
    await page.keyboard.press('Control+A'); await page.keyboard.type(`Ends after ${lab(1)}`);
    await blur(page); await settle(page);
    s = await series(page);
    check('…and to an earlier month shortens it', s.length === 2, JSON.stringify(s.map((c) => c.mi)));
    await ctx.close();
  }

  {
    // clearing "ev N mo" and re-entering it is the other way back to indefinite
    const { ctx, page } = await fresh();
    let s = await series(page);
    const total = s.length;
    await deleteGhostCard(page, s[3].id);
    await page.fill('.card[data-id="oi_root"] .recur-ctl-n', '');
    await settle(page);
    check('clearing ev: the prefix goes with it', (await rootNotes(page)) === '' && (await series(page)).length === 1, JSON.stringify(await rootNotes(page)));
    await setEv(page, 'oi_root', 1);
    s = await series(page);
    check('re-entering ev: the series is indefinite again', s.length === total, JSON.stringify({ n: s.length, total }));
    await ctx.close();
  }

  {
    // changing the interval keeps the end
    const { ctx, page } = await fresh();
    let s = await series(page);
    await deleteGhostCard(page, s[3].id); // root + 2 ghosts, ends after +2
    await setEv(page, 'oi_root', 2);
    s = await series(page);
    check('changing ev on an ended series keeps the end (root + the +2 month)', s.length === 2 && s[1].mi - s[0].mi === 2, JSON.stringify(s.map((c) => c.mi)));
    await ctx.close();
  }

  {
    // an every-2-months series: the label is the last occurrence, not the deleted month
    const { ctx, page } = await fresh((b) => { b.items[0].recur = 2; });
    let s = await series(page);
    await deleteGhostCard(page, s[2].id); // ghosts at +2, +4, ...; delete the +4 one
    s = await series(page);
    check('ev 2: ends after the last month that still has one', s.length === 2 && (await rootNotes(page)) === `Ends after ${lab(2)}`, JSON.stringify({ mi: s.map((c) => c.mi), notes: await rootNotes(page) }));
    await ctx.close();
  }

  {
    // deleting the ORDER holding a projection does the same thing (this is how the gap used to happen)
    const { ctx, page } = await fresh();
    let s = await series(page);
    const shipId = await page.evaluate((id) => document.querySelector(`.card[data-id="${id}"]`).closest('.shipment').dataset.id, s[2].id);
    dialogAnswer = false;
    await clickMenu(page, `.shipment[data-id="${shipId}"] [data-act="open-ship-menu"]`, 'Delete');
    check('cancelling the order delete keeps the whole series', (await series(page)).length === s.length);
    dialogAnswer = true;
    await clickMenu(page, `.shipment[data-id="${shipId}"] [data-act="open-ship-menu"]`, 'Delete');
    s = await series(page);
    check('deleting the order ends the series there too (no gap)', s.length === 2 && gaps(s).every((g) => g === 1) && (await rootNotes(page)) === `Ends after ${lab(1)}`, JSON.stringify({ mi: s.map((c) => c.mi), notes: await rootNotes(page) }));
    check('the future months of that order are gone too (no empty shells)', await page.evaluate(() => [...document.querySelectorAll('.shipment[data-id^="gs_"]')].length) === 1);
    await ctx.close();
  }

  {
    // placing the root's order afterwards: the new root carries the end, earlier items untouched
    const { ctx, page } = await fresh();
    let s = await series(page);
    await deleteGhostCard(page, s[4].id); // root + 3 ghosts, ends after +3
    await page.evaluate(() => document.querySelector('.shipment[data-id="o_root"] [data-act="set-stage"][data-stage="ordered"]').click());
    await settle(page);
    s = await series(page);
    check('after ordering the root the series is still cut short', s.length === 4 && s[3].mi - s[0].mi === 3, JSON.stringify(s.map((c) => c.mi)));
    check('the new root still says where it ends', s[1].notes.startsWith(`Ends after ${lab(3)}`), JSON.stringify(s.map((c) => c.notes)));
    // now delete again from the new root's series: the placed (locked) first order must stay
    await deleteGhostCard(page, s[3].id);
    s = await series(page);
    check('past (placed) items are never deleted', s.length === 3 && s[0].id === 'oi_root' && s[0].ghost === false, JSON.stringify(s.map((c) => c.mi)));
    check('the end moves to the new last month', s[1].notes.startsWith(`Ends after ${lab(2)}`), JSON.stringify(s.map((c) => c.notes)));
    await ctx.close();
  }
  // ── duplicating a recurring item / its order: the copy gets its OWN future ghosts ──
  const perMonth = (page, name = 'Rooty') => page.evaluate((name) => [...document.querySelectorAll('#board > .month')].map((m) => [...m.querySelectorAll('.card[data-id] .card-name')].filter((n) => n.textContent.trim() === name).length), name);
  const dupMenu = async (page, sel) => clickMenu(page, sel, 'Duplicate');
  {
    const { ctx, page } = await fresh();
    const before = await perMonth(page);
    check('(setup) one Rooty per month from the current one on', before.filter(Boolean).length > 5 && before.every((n) => n <= 1), JSON.stringify(before));
    await dupMenu(page, '.shipment[data-id="o_root"] [data-act="open-ship-menu"]');
    const after = await perMonth(page);
    check('duplicating the ORDER: every month now holds a second one (the copy\'s own ghosts)', after.every((n, i) => n === before[i] * 2), JSON.stringify({ before, after }));
    const twoRoots = await page.evaluate(() => [...document.querySelectorAll('.card[data-id]')].filter((c) => c.querySelector('.card-name')?.textContent.trim() === 'Rooty' && !c.classList.contains('card--ghost')).length);
    check('…with exactly 2 real (non-ghost) ones, both still recurring', twoRoots === 2);
    await settle(page);
    check('saved: both series persisted (2 per month)', dbItems().length === before.reduce((a, b) => a + b, 0) * 2, JSON.stringify({ n: dbItems().length }));
    await ctx.close();
    const again = await openBoard();
    check('after a reload nothing changes (no extra ghosts, none missing)', JSON.stringify(await perMonth(again.page)) === JSON.stringify(after), JSON.stringify(await perMonth(again.page)));
    await again.ctx.close();
  }
  {
    const { ctx, page } = await fresh();
    const before = await perMonth(page);
    await dupMenu(page, '.card[data-id="oi_root"] [data-act="open-card-menu"]');
    const after = await perMonth(page);
    check('duplicating the ITEM: its copy gets its own ghosts too', after.every((n, i) => n === before[i] * 2), JSON.stringify({ before, after }));
    await ctx.close();
  }
  {
    // duplicating an order that only holds projections doesn't copy the projections (nothing to put in the copy)
    const { ctx, page } = await fresh();
    const s = await series(page);
    const shipId = await page.evaluate((id) => document.querySelector(`.card[data-id="${id}"]`).closest('.shipment').dataset.id, s[2].id);
    const before = await perMonth(page);
    await dupMenu(page, `.shipment[data-id="${shipId}"] [data-act="open-ship-menu"]`);
    check('duplicating an order of projections adds no stray duplicate ghosts', JSON.stringify(await perMonth(page)) === JSON.stringify(before), JSON.stringify(await perMonth(page)));
    await ctx.close();
  }
} catch (e) {
  errors.push('TEST CRASH: ' + (e && e.stack || e));
}

await browser.close();
server.close();
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + c.detail}`);
if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.join('\n'));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length || errors.length ? 1 : 0);
