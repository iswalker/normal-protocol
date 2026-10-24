/* functions/_middleware.js -- second lock behind Cloudflare Access.

   Cloudflare Access (Zero Trust application "Normal Protocol", policy "Owner
   only") already stops anonymous visitors at the edge: every request that
   reaches this project has a signed token in the Cf-Access-Jwt-Assertion
   header. This middleware re-checks that token on EVERY request -- the page,
   the static files and all of /api/* -- so the app stays closed even if
   someone reaches it by a route Access doesn't cover (for example a preview
   deployment's own hostname, or a policy that gets loosened by mistake).

   A request passes only if the token
     - is signed (RS256) by one of the team's published keys,
     - was issued by this team (iss), for THIS application (aud),
     - has not expired.
   Anything else gets a plain 401. It fails closed: no token, an unreadable
   token, or keys that can't be fetched all mean 401.

   The team domain and AUD tag are identifiers, not secrets (the AUD tag is
   shown in Zero Trust > Access > Applications > Normal Protocol > Additional
   settings). Local development (scripts/dev-server.mjs, which never goes
   through Pages Functions) is unaffected; a request to localhost is let
   through in case wrangler's local runtime is ever used. */

const TEAM_DOMAIN = "calm-limit-d44c.cloudflareaccess.com";
const AUD = "ecf208d18149a8df5f01263075d1f0f48921eeb238b250a545eb3ca6417b22dd";

const KEYS_TTL_MS = 60 * 60 * 1000; // Access rotates keys on a weeks-long schedule
let keyCache = { at: 0, keys: [] };

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function loadKeys(force) {
  if (!force && keyCache.keys.length && Date.now() - keyCache.at < KEYS_TTL_MS) return keyCache.keys;
  const res = await fetch(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("certs HTTP " + res.status);
  const keys = (await res.json()).keys || [];
  if (!keys.length) throw new Error("no keys published");
  keyCache = { at: Date.now(), keys };
  return keys;
}

// Resolves to the token's claims, or throws.
export async function verifyAccessToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = b64urlToJson(parts[0]);
  if (header.alg !== "RS256") throw new Error("unexpected alg"); // never trust "none"/HS256
  let keys = await loadKeys(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await loadKeys(true); jwk = keys.find((k) => k.kid === header.kid); } // rotated since we cached
  if (!jwk) throw new Error("unknown key id");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]),
  );
  if (!ok) throw new Error("bad signature");
  const claims = b64urlToJson(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== `https://${TEAM_DOMAIN}`) throw new Error("wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(AUD)) throw new Error("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("not yet valid");
  return claims;
}

const cookieToken = (request) => {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : "";
};

export async function onRequest({ request, next }) {
  const host = new URL(request.url).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return next();
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookieToken(request);
  try {
    await verifyAccessToken(token);
  } catch (e) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return next();
}
