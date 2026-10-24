/* verify-access-middleware.mjs -- offline test of functions/_middleware.js.

   Generates a throwaway RSA keypair, serves its public key from a mocked
   Cloudflare "certs" endpoint (global fetch is replaced -- nothing touches the
   network), signs tokens, and drives the middleware with good and bad ones.

   Run:  npm run verify:access */
import { generateKeyPairSync, createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const TEAM = 'calm-limit-d44c.cloudflareaccess.com';
const AUD = 'ecf208d18149a8df5f01263075d1f0f48921eeb238b250a545eb3ca6417b22dd';

const b64u = (b) => Buffer.from(b).toString('base64url');
const pair = (kid) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
};
const A = pair('key-A'), B = pair('key-B'), ROGUE = pair('key-A'); // ROGUE reuses A's kid with a different key
let published = [A.jwk];
let certFetches = 0;
globalThis.fetch = async (url) => {
  if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error('unexpected fetch ' + url);
  certFetches++;
  return new Response(JSON.stringify({ keys: published }), { status: 200 });
};
const sign = (kp, claims, headerOver = {}) => {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: kp.kid, typ: 'JWT', ...headerOver }));
  const p = b64u(JSON.stringify(claims));
  const sig = createSign('RSA-SHA256').update(h + '.' + p).sign(kp.privateKey);
  return h + '.' + p + '.' + b64u(sig);
};
const now = Math.floor(Date.now() / 1000);
const good = { iss: `https://${TEAM}`, aud: [AUD], exp: now + 3600, iat: now, email: 'owner@example.com' };

const { onRequest } = await import(pathToFileURL(join(ROOT, 'functions', '_middleware.js')).href);
const call = async (url, headers = {}) => {
  let reached = false;
  const res = await onRequest({ request: new Request(url, { headers }), next: async () => { reached = true; return new Response('app'); } });
  return { status: res.status, reached };
};
const PROD = 'https://normal-protocol.pages.dev/api/orders';
const checks = [];
const check = (name, cond, detail = '') => checks.push({ name, ok: !!cond, detail });

let r = await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(A, good) });
check('a valid Access token passes through to the app', r.reached && r.status === 200, JSON.stringify(r));
r = await call(PROD, { Cookie: 'x=1; CF_Authorization=' + sign(A, good) + '; y=2' });
check('a valid token in the CF_Authorization cookie also passes', r.reached, JSON.stringify(r));
r = await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(A, { ...good, aud: AUD }) });
check('aud given as a plain string (not an array) passes', r.reached);
r = await call(PROD);
check('no token -> 401, app never reached', r.status === 401 && !r.reached, JSON.stringify(r));
r = await call(PROD, { 'Cf-Access-Jwt-Assertion': 'garbage' });
check('a malformed token -> 401', r.status === 401 && !r.reached);
r = await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(A, { ...good, exp: now - 10 }) });
check('an expired token -> 401', r.status === 401 && !r.reached);
r = await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(A, { ...good, aud: ['someone-elses-app'] }) });
check('a token for a DIFFERENT application -> 401', r.status === 401 && !r.reached);
r = await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(A, { ...good, iss: 'https://evil.cloudflareaccess.com' }) });
check('a token from a different team -> 401', r.status === 401 && !r.reached);
r = await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(ROGUE, good) });
check('a token signed with the wrong key (even under a known kid) -> 401', r.status === 401 && !r.reached);
{ // tamper with the payload after signing
  const t = sign(A, good).split('.');
  t[1] = b64u(JSON.stringify({ ...good, email: 'someone-else@example.com', exp: now + 999999 }));
  r = await call(PROD, { 'Cf-Access-Jwt-Assertion': t.join('.') });
  check('a token whose payload was edited after signing -> 401', r.status === 401 && !r.reached);
}
{ // alg=none / HS256 downgrade attempts
  const h = b64u(JSON.stringify({ alg: 'none', typ: 'JWT' })), p = b64u(JSON.stringify(good));
  r = await call(PROD, { 'Cf-Access-Jwt-Assertion': h + '.' + p + '.' });
  check('an unsigned (alg=none) token -> 401', r.status === 401 && !r.reached);
  r = await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(A, good, { alg: 'HS256' }) });
  check('an alg-swapped (HS256) token -> 401', r.status === 401 && !r.reached);
}
r = await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(B, good) });
check('a token from a key not published yet -> 401', r.status === 401 && !r.reached);
published = [A.jwk, B.jwk]; // Access rotates in a new key: the middleware refetches on an unknown kid
r = await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(B, good) });
check('after key rotation the new key is picked up automatically', r.reached, JSON.stringify(r));
const before = certFetches;
await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(A, good) });
await call(PROD, { 'Cf-Access-Jwt-Assertion': sign(B, good) });
check('keys are cached (no refetch per request)', certFetches === before, `${before} -> ${certFetches}`);
// static assets are gated too, and localhost (the dev server) is not
r = await call('https://normal-protocol.pages.dev/intakes.csv');
check('static files are gated the same way', r.status === 401 && !r.reached);
r = await call('http://localhost:8788/api/orders');
check('localhost is let through (local dev)', r.reached);
// fail closed when the keys can't be fetched at all
globalThis.fetch = async () => { throw new Error('network down'); };
published = [];
{ // new module instance = empty cache
  const m2 = await import(pathToFileURL(join(ROOT, 'functions', '_middleware.js')).href + '?cold=1');
  const res = await m2.onRequest({ request: new Request(PROD, { headers: { 'Cf-Access-Jwt-Assertion': sign(A, good) } }), next: async () => new Response('app') });
  check('fails CLOSED when the signing keys cannot be fetched', res.status === 401, String(res.status));
}

let failed = 0;
for (const c of checks) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : '  →  ' + c.detail}`); if (!c.ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
