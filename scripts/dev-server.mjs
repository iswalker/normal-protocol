/* dev-server.mjs — local dev server that serves the app AND the /api/* Pages
   Functions, by importing the real handlers and calling them with env from
   .dev.vars. Use this instead of `wrangler pages dev .` (which reload-loops on
   this setup). Serves on http://localhost:8788 — an authorized OAuth origin.

   Run:  npm run dev:local      then open http://localhost:8788 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as orders from '../functions/api/orders.js';
import * as intakes from '../functions/api/intakes.js';
import * as suppliers from '../functions/api/suppliers.js';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const PORT = Number(process.env.PORT) || 8788;

const env = {};
for (const line of (await readFile(join(ROOT, '.dev.vars'), 'utf8')).split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2];
}

const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon','.png':'image/png' };

// route table: path -> { METHOD: handlerExport }
const ROUTES = {
  '/api/orders': { GET: orders.onRequestGet, PUT: orders.onRequestPut },
  '/api/intakes': { GET: intakes.onRequestGet },
  '/api/suppliers': { GET: suppliers.onRequestGet },
};

async function readBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = ROUTES[url.pathname];
    if (route) {
      const handler = route[req.method];
      if (!handler) { res.writeHead(405); res.end(); return; }
      const buf = await readBody(req);
      const request = { json: async () => JSON.parse(buf.toString('utf8') || '{}'), text: async () => buf.toString('utf8') };
      const r = await handler({ env, request, params: {} });
      const body = await r.text();
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(body);
      return;
    }
    if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('{"error":"no route"}'); return; }
    let p = decodeURIComponent(url.pathname); if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500);
    res.end(String(e && e.message || e));
  }
});

server.listen(PORT, () => console.log(`dev server: http://localhost:${PORT}  (Ctrl+C to stop)`));
