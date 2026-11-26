/* Kallubi Pay · payment-check proxy (Cloudflare Worker) · v1.3.0 · NOT DEPLOYED
   GET /api/pay/check?to=<P2PKH address>&amount=<sats>&since=<unix seconds>[&match=exact|min]
   -> { ok:true, matches:[{ txid, sats, confirmations, exact }] }   (txs paying `to`, not older than `since`)
   match=exact (default since v1.3.0): only txs paying EXACTLY `amount` are matches; txs paying more are listed with
   overpaid:true (the button shows "contact the shop", never "paid"). match=min: the pre-1.3 rule (>= amount).
   The answer is only a hint: the button re-checks every amount from the raw transaction (hash = txid).

   Why a proxy at all (the widget can also talk to WhatsOnChain directly):
   - one shared edge cache per address (4 s) and per tx (1 h): 100 open dialogs on one shop = ~1 upstream call / 4 s
   - optional WoC API key (secret WOC_API_KEY) for a higher, predictable quota; on WoC 429 we serve the last cached answer
   - the buyer's IP is never sent to WhatsOnChain
   Privacy: no logging, no cookies, no storage of IPs. The rate-limit key is a SHA-256 of (secret salt + day + IP), computed
   in memory only and handed to the Cloudflare rate-limit binding; nothing is written anywhere by this code.
   v1.3.0: the salt is secret (wrangler secret put RL_SALT, >= 32 random characters). Without it a random per-isolate salt
   is used, so the key can never be recomputed from a known IP by anyone outside the running worker.
   Receive-only: only public addresses, no keys, no signing, no custody. */

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const LIST_TTL_S = 4;           // edge cache for address history lists
const TX_TTL_S = 3600;          // edge cache for tx details (outputs never change)
const UNCONF_TX_TTL_S = 10;  // unconfirmed tx: short cache, confirmations change
const MAX_TX_LOOKUPS = 12;      // per request (newest first)
const SINCE_SLACK_S = 600;      // clock slack for "since"
const MAX_SATS = 2100000000000000;

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',          // public, read-only data, no credentials
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
const json = (status, obj, extra) => new Response(JSON.stringify(obj), { status, headers: { ...HEADERS, ...(extra || {}) } });
const err = (status, code, extra) => json(status, { ok: false, error: code }, extra);

/* ---- address check (mainnet P2PKH, base58check), same logic as Ask Kallubi's payScript() ---- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const hex = (u8) => [...new Uint8Array(u8)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function addressScript(addr) {
  if (typeof addr !== 'string' || !/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(addr)) return null;
  let n = 0n; for (const ch of addr) n = n * 58n + BigInt(B58.indexOf(ch));
  let h = n.toString(16); if (h.length % 2) h = '0' + h;
  for (const ch of addr) { if (ch === '1') h = '00' + h; else break; }
  if (h.length !== 50) return null;
  const bytes = new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
  if (bytes[0] !== 0) return null;
  const c = new Uint8Array(await crypto.subtle.digest('SHA-256', await crypto.subtle.digest('SHA-256', bytes.slice(0, 21))));
  for (let i = 0; i < 4; i++) if (c[i] !== bytes[21 + i]) return null;
  return '76a914' + h.slice(2, 42) + '88ac';
}
export function satsToScript(tx, script) {
  let s = 0;
  for (const v of Array.isArray(tx && tx.vout) ? tx.vout : []) {
    const sp = v && v.scriptPubKey;
    if (sp && typeof sp.hex === 'string' && sp.hex.toLowerCase() === script) s += Math.round((Number(v.value) || 0) * 1e8);
  }
  return s;
}

/* ---- cached upstream fetch ---- */
async function woc(path, ttl, env, ctx) {
  const base = (env && env.WOC_BASE) || WOC;
  const url = base + path;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request('https://kallubi-pay-cache.invalid' + path);
  if (cache) { const hit = await cache.match(key); if (hit) return { status: 200, body: await hit.json(), cached: true }; }
  const headers = { Accept: 'application/json' };
  if (env && env.WOC_API_KEY) headers['woc-api-key'] = env.WOC_API_KEY;
  const r = await fetch(url, { headers });
  if (r.status === 404) return { status: 404 };
  if (!r.ok) return { status: r.status };
  const text = await r.text();
  if (text.length > 3000000) return { status: 502 };
  let body; try { body = JSON.parse(text); } catch (e) { return { status: 502 }; }   // HTML / garbage instead of JSON = upstream error
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + (typeof ttl === 'function' ? ttl(body) : ttl) } }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  }
  return { status: 200, body };
}
const listHashes = (b) => (Array.isArray(b) ? b : (b && Array.isArray(b.result) ? b.result : []))
  .map((x) => x && x.tx_hash).filter((h) => /^[0-9a-f]{64}$/.test(h || ''));

export async function check(to, sats, since, env, ctx, match = 'exact') {
  const script = await addressScript(to);
  if (!script) return err(400, 'bad_address');
  const [u, c] = await Promise.all([
    woc('/address/' + to + '/unconfirmed/history', LIST_TTL_S, env, ctx),
    woc('/address/' + to + '/confirmed/history?order=desc&limit=20', LIST_TTL_S, env, ctx),
  ]);
  if (u.status === 429 || c.status === 429) return err(503, 'upstream_busy', { 'Retry-After': '10' });
  if (u.status !== 200 && c.status !== 200) return err(502, 'upstream');
  const uh = u.status === 200 ? listHashes(u.body) : [];
  const ch = c.status === 200 ? listHashes(c.body).reverse() : [];   // newest first
  const seen = new Set(); const cand = [];
  for (const h of [...uh, ...ch]) if (!seen.has(h)) { seen.add(h); cand.push(h); }
  const matches = [];
  for (const h of cand.slice(0, MAX_TX_LOOKUPS)) {
    // confirmed txs are immutable (1 h); unconfirmed ones only briefly, so the confirmation shows up quickly
    const t = await woc('/tx/hash/' + h, (b) => (Number(b && b.confirmations) > 0 ? TX_TTL_S : UNCONF_TX_TTL_S), env, ctx);
    if (t.status === 429) break;                  // keep what we have, client polls again
    if (t.status !== 200 || !t.body || String(t.body.txid || t.body.hash || '').toLowerCase() !== h) continue;
    const bt = Number(t.body.blocktime || t.body.time || 0);
    if (Number(t.body.confirmations) > 0 && !bt) continue;   // v1.3.0 fail-closed: confirmed but no block time = age unknown, never a match
    if (bt && bt < since - SINCE_SLACK_S) continue;
    const got = satsToScript(t.body, script);
    if (got < sats) continue;
    const m = { txid: h, sats: got, confirmations: Number(t.body.confirmations) || 0, exact: got === sats };
    if (match === 'exact' && got > sats) m.overpaid = true;     // listed so the button can say "contact the shop", never a match
    matches.push(m);
  }
  return json(200, { ok: true, matches });
}

let isolateSalt = null;
export function rateSalt(env) {
  const s = env && typeof env.RL_SALT === 'string' ? env.RL_SALT : '';
  if (s.length >= 32) return s;
  if (!isolateSalt) { const b = new Uint8Array(32); crypto.getRandomValues(b); isolateSalt = hex(b); }   // random, never leaves memory
  return isolateSalt;
}
export async function clientKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const day = new Date().toISOString().slice(0, 10);
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rateSalt(env) + '|' + day + '|' + ip)));   // in memory only
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    if (url.pathname !== '/api/pay/check') return err(404, 'not_found');
    if (request.method !== 'GET') return err(405, 'method');
    try {
      const to = (url.searchParams.get('to') || '').trim();
      const sats = Number(url.searchParams.get('amount'));
      const since = Number(url.searchParams.get('since') || 0);
      if (!Number.isInteger(sats) || sats < 1 || sats > MAX_SATS) return err(400, 'bad_amount');
      if (!Number.isInteger(since) || since < 0 || since > 4e9) return err(400, 'bad_since');
      const match = url.searchParams.get('match') || 'exact';
      if (match !== 'exact' && match !== 'min') return err(400, 'bad_match');
      if (env && env.PAY_RL && typeof env.PAY_RL.limit === 'function') {           // Cloudflare rate-limit binding
        const { success } = await env.PAY_RL.limit({ key: await clientKey(request, env) });
        if (!success) return err(429, 'rate_limited', { 'Retry-After': '30' });
      }
      return await check(to, sats, since, env, ctx, match);
    } catch (e) { return err(500, 'internal'); }    // no details, nothing logged
  },
};
