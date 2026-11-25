/* Kallubi Pay · server-side payment verification for shops · v1.2.0 · Apache-2.0
 *
 * Why this exists: the browser events of the Pay Button (kallubi:paid, data-on-paid) are UX only. Anyone who controls a
 * browser can fire them with made-up data. A shop must decide "paid" on its OWN server, from the blockchain, never from
 * the browser. This module does exactly that, with no dependencies (Node 18+), no keys and no secrets.
 *
 * What verifyPayment() checks
 *   1. It downloads the RAW transaction (WhatsOnChain or your own BSV node via RPC) and checks that its double-SHA256
 *      equals the txid. The amounts come from parsing these raw bytes, not from anybody's JSON.
 *   2. The outputs that pay your address (mainnet P2PKH) add up to the expected amount
 *      (exactSats = must match exactly, recommended; or minSats = at least).
 *   3. Confirmation policy (same as the button): the threshold is an EUR amount (zeroConfUpToCents, default 200.00).
 *      With a passed quick check (own node + BSV Broadcaster, final tx, sufficient fee, no double-spend in a 5 s window)
 *      amounts up to that line are accepted at 0-conf; above it 1 confirmation is required. If the quick check is
 *      unavailable, 0-conf is only used up to 20.00 EUR (fallbackZeroConfUpToCents). USD thresholds are converted from
 *      EUR with the ECB rate (floored); BSV-priced orders convert the same EUR line with the EUR/BSV rate. Without a
 *      valid rate the helper waits for 1 confirmation. An explicit confirmFromSats is a BSV override. minConfirmations
 *      can only make this stricter. The payment is not older than the order (createdAt).
 *   4. Expiry: a payment the server only sees after expiresAt is reported as status 'late' (not paid) unless acceptLate.
 *   5. Replay protection: one txid can pay ONE order only (claims store, e.g. a UNIQUE(txid) column in your database).
 *
 * Trust note (honest): the raw bytes are verified, so a data source cannot invent or change amounts. Whether the
 * transaction exists / is confirmed is reported by the source. Use your own node (rpc) or wait for confirmations for
 * high amounts. 0-conf on BSV is first-seen and never 100 % safe: a competing double-spend can still appear after the
 * 5 s window. That residual risk is a shop decision; wait for 1 confirmation when in doubt.
 */
import { createHash, randomInt } from 'node:crypto';

export const VERSION = '1.2.0';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const CG = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=eur,usd&include_last_updated_at=true';
const MAX_SATS = 2100000000000000;
const MAX_TX_BYTES = 10 * 1024 * 1024;       // 10 MB raw tx is far above anything a shop payment needs
const OLD_SLACK_S = 7200;                    // block timestamps may be off by up to ~2 h (consensus rules)
const RATE_MAX_AGE_S = 600, RATE_FUTURE_S = 300, RATE_MAX = 10000000;
const ECB_XML = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';   // official ECB reference rates (daily)
const ECB_MAX_AGE_D = 5, ECB_CACHE_S = 3600, ECB_MIN = 0.5, ECB_MAX = 2;
export const ZERO_CONF_UP_TO_CENTS = 20000;              // 200.00 EUR (with a passed quick check)
export const FALLBACK_ZERO_CONF_UP_TO_CENTS = 2000;      // 20.00 EUR when the quick check is unavailable
export const CONFIRM_FROM_SATS = 1000000;                // optional explicit BSV override (0.01 BSV), no longer the default
export const FINAL_SEQUENCE = 0xffffffff;
export const DEFAULT_FEE_SAT_PER_KB = 100;
export const BROADCASTERS = ['https://arcade-eu-1.bsvblockchain.tech', 'https://arcade-us-1.bsvblockchain.tech', 'https://arcade.gorillapool.io'];
const QC_GOOD = new Set(['SEEN_ON_NETWORK', 'MINED', 'IMMUTABLE']);
const QC_BAD = new Set(['DOUBLE_SPEND_ATTEMPTED', 'REJECTED', 'INVALID', 'MALFORMED', 'MINED_IN_STALE_BLOCK']);
// Only quick-check results produced by runQuickCheck() on YOUR server count. A browser event (kallubi:paid detail.quickCheck)
// can be forged by the buyer, so a plain { ok: true } object from outside is ignored.
const TRUSTED_QC = new WeakSet();

const sha256 = (b) => createHash('sha256').update(b).digest();
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** mainnet P2PKH address ("1…", checksum verified) -> locking script hex, or null */
export function addressToScript(addr) {
  if (typeof addr !== 'string' || !/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(addr)) return null;
  let n = 0n; for (const ch of addr) n = n * 58n + BigInt(B58.indexOf(ch));
  let h = n.toString(16); if (h.length % 2) h = '0' + h;
  for (const ch of addr) { if (ch === '1') h = '00' + h; else break; }
  if (h.length !== 50) return null;
  const raw = Buffer.from(h, 'hex');
  if (raw[0] !== 0) return null;
  const chk = sha256(sha256(raw.subarray(0, 21)));
  if (!chk.subarray(0, 4).equals(raw.subarray(21, 25))) return null;
  return '76a914' + raw.subarray(1, 21).toString('hex') + '88ac';
}

/** txid of a raw transaction (hex): double SHA-256, byte-reversed */
export function txidFromRaw(hex) { return Buffer.from(sha256(sha256(Buffer.from(hex, 'hex')))).reverse().toString('hex'); }

/** Strict raw transaction parser. Throws on anything malformed (truncated, trailing bytes, absurd counts). */
export function parseRawTx(hex) {
  if (typeof hex !== 'string' || !hex.length || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex) || hex.length / 2 > MAX_TX_BYTES) throw new Error('bad_hex');
  const b = Buffer.from(hex, 'hex'); let o = 0;
  const need = (n) => { if (o + n > b.length) throw new Error('truncated'); };
  const u32 = () => { need(4); const v = b.readUInt32LE(o); o += 4; return v; };
  const varint = () => {
    need(1); const f = b[o++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { need(2); const v = b.readUInt16LE(o); o += 2; return v; }
    if (f === 0xfe) { need(4); const v = b.readUInt32LE(o); o += 4; return v; }
    need(8); const v = b.readBigUInt64LE(o); o += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('varint');
    return Number(v);
  };
  const bytes = (n) => { if (n > b.length) throw new Error('truncated'); need(n); const s = b.subarray(o, o + n); o += n; return s; };
  const version = u32();
  const nIn = varint(); if (nIn < 1 || nIn > b.length / 41) throw new Error('inputs');
  const inputs = [];
  for (let i = 0; i < nIn; i++) {
    const prev = Buffer.from(bytes(32)).reverse().toString('hex'); const vout = u32();
    const script = bytes(varint()).toString('hex'); const sequence = u32();
    inputs.push({ prevTxid: prev, vout, script, sequence });
  }
  const nOut = varint(); if (nOut < 1 || nOut > b.length / 9) throw new Error('outputs');
  const outputs = []; let total = 0n;
  for (let i = 0; i < nOut; i++) {
    need(8); const sats = b.readBigUInt64LE(o); o += 8;
    if (sats > BigInt(MAX_SATS)) throw new Error('value');
    total += sats; if (total > BigInt(MAX_SATS)) throw new Error('value');
    outputs.push({ n: i, sats: Number(sats), script: bytes(varint()).toString('hex') });
  }
  const locktime = u32();
  if (o !== b.length) throw new Error('trailing');
  return { version, inputs, outputs, locktime };
}

/** Same rule as the button: cents + fiat rate -> sats, rounded UP. rate: number or decimal string (fiat per 1 BSV). */
export function fiatToSats(cents, rate) {
  if (!Number.isSafeInteger(cents) || cents < 1) throw new RangeError('cents');
  const micro = rateMicro(rate); if (micro == null) throw new RangeError('rate');
  const num = BigInt(cents) * 1000000000000n, den = BigInt(micro);
  let q = num / den; if (num % den) q += 1n;
  if (q < 1n || q > BigInt(MAX_SATS)) throw new RangeError('sats');
  return Number(q);
}
/** Level 1 helper (button converts in the browser): the LEAST your server accepts for a fiat price, computed from a rate
 *  YOUR server fetched. tolerancePct covers rate movement during the payment window (default 2 %). */
export function minSatsFromFiat(cents, rate, tolerancePct = 2) {
  if (!(tolerancePct >= 0 && tolerancePct <= 20)) throw new RangeError('tolerancePct');
  const s = fiatToSats(cents, rate);
  return Math.max(1, Math.floor(s * (100 - tolerancePct) / 100));
}
export function rateMicro(r) {
  const n = typeof r === 'number' ? r : (typeof r === 'string' && /^\d{1,8}(\.\d{1,12})?$/.test(r) ? Number(r) : NaN);
  if (!Number.isFinite(n) || n <= 0 || n > RATE_MAX) return null;
  const u = Math.round(n * 1e6); return u >= 1 ? u : null;
}
export function fmtBsv(sats) { const s = String(sats).padStart(9, '0'); const f = s.slice(-8).replace(/0+$/, ''); return s.slice(0, -8) + (f ? '.' + f : ''); }

async function getJson(url, f, headers) {
  const r = await f(url, { headers: { Accept: 'application/json', ...(headers || {}) }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return { status: 404 };
  if (!r.ok) return { status: r.status };
  const t = await r.text(); if (t.length > MAX_TX_BYTES * 2 + 4096) return { status: 502 };
  return { status: 200, body: JSON.parse(t), text: t };
}

/** ECB daily XML -> { usdPerEur, date } or null. Plausible (0.5-2.0), not in the future, at most 5 calendar days old
 *  (the ECB publishes on working days only: weekends and Easter/Christmas closures are covered). */
export function parseEcbXml(xml, now = Math.floor(Date.now() / 1000)) {
  if (typeof xml !== 'string' || xml.length > 200000) return null;
  const d = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/g), r = xml.match(/<Cube\s+currency=['"]USD['"]\s+rate=['"](\d\.\d{1,6})['"]\s*\/>/g);
  if (!d || !r || d.length !== 1 || r.length !== 1) return null;
  const date = /(\d{4}-\d{2}-\d{2})/.exec(d[0])[1], v = Number(/rate=['"]([\d.]+)/.exec(r[0])[1]);
  const day = Date.parse(date + 'T00:00:00Z') / 1000, today = Math.floor(now / 86400) * 86400;
  if (!(v >= ECB_MIN && v <= ECB_MAX) || !Number.isFinite(day) || day > today || today - day > ECB_MAX_AGE_D * 86400) return null;
  return { usdPerEur: v, date };
}
let ecbCache = null;
export function clearEcbCache() { ecbCache = null; }
async function fetchEcb(f, now, url) {
  if (ecbCache && ecbCache.url === url && now - ecbCache.at >= 0 && now - ecbCache.at < ECB_CACHE_S && parseEcbXml(ecbCache.xml, now)) return parseEcbXml(ecbCache.xml, now);
  const r = await f(url, { headers: { Accept: 'application/xml' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('ecb');
  const xml = await r.text(), v = parseEcbXml(xml, now);
  if (!v) throw new Error('ecb');
  ecbCache = { url, xml, at: now };
  return v;
}

/** EUR cents * USD-per-EUR, rounded DOWN so the 0-conf line is never above the EUR amount. */
export function eurToUsdCents(eurCents, usdPerEur) {
  const micro = rateMicro(usdPerEur);
  if (micro == null || !Number.isInteger(eurCents) || eurCents < 0) return null;
  return Number(BigInt(eurCents) * BigInt(micro) / 1000000n);
}
/** EUR cents -> sats at EUR/BSV, rounded DOWN. */
export function eurToSatsFloor(cents, rate) {
  const micro = rateMicro(rate);
  if (micro == null || !Number.isInteger(cents) || cents < 1) return null;
  const q = BigInt(cents) * 1000000000000n / BigInt(micro);
  if (q > BigInt(MAX_SATS) || q < 0n) return null;
  return Number(q);
}
export function isTxFinal(tx, nowS, tipHeight) {
  if (!tx || !Array.isArray(tx.inputs) || !tx.inputs.length) return false;
  const allFinal = tx.inputs.every((i) => i.sequence === FINAL_SEQUENCE);
  if (allFinal || tx.locktime === 0) return true;
  if (tx.locktime < 500000000) return tipHeight != null && tipHeight >= tx.locktime;
  return nowS != null && nowS >= tx.locktime;
}
export function feeSufficient(feeSats, size, satPerKb = DEFAULT_FEE_SAT_PER_KB) {
  if (!Number.isSafeInteger(feeSats) || feeSats < 0 || !Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(satPerKb) || satPerKb < 1) return false;
  return BigInt(feeSats) * 1000n >= BigInt(satPerKb) * BigInt(size);
}

/** How many confirmations an order needs (same policy as the button).
 *  The shop threshold (zeroConfUpToCents, default 20000 = 200.00 EUR) is always an EUR amount.
 *  USD is converted with usdPerEur (ECB); BSV with eurRate. Without a valid rate -> 1.
 *  0-conf above the 20.00 EUR fallback requires quickCheck.ok. An explicit confirmFromSats is a BSV override. */
export function requiredConfirmations({
  cents, sats, currency, usdPerEur, eurRate,
  zeroConfUpToCents = ZERO_CONF_UP_TO_CENTS,
  fallbackZeroConfUpToCents = FALLBACK_ZERO_CONF_UP_TO_CENTS,
  confirmFromSats, quickCheck,
} = {}) {
  if (!Number.isInteger(zeroConfUpToCents) || zeroConfUpToCents < 0 || zeroConfUpToCents > 100000000) throw new RangeError('zeroConfUpToCents');
  if (!Number.isInteger(fallbackZeroConfUpToCents) || fallbackZeroConfUpToCents < 0 || fallbackZeroConfUpToCents > 100000000) throw new RangeError('fallbackZeroConfUpToCents');
  const qcOk = isTrustedQuickCheck(quickCheck) && quickCheck.ok === true;
  if (cents != null) {
    if (!Number.isInteger(cents) || cents < 1 || cents > 100000000) throw new RangeError('cents');
    const cur = currency == null ? 'EUR' : String(currency).toUpperCase();
    let high = zeroConfUpToCents, fb = fallbackZeroConfUpToCents;
    if (cur === 'USD') {
      const h = eurToUsdCents(high, usdPerEur), f = eurToUsdCents(fb, usdPerEur);
      if (h == null || f == null) return 1;
      high = h; fb = f;
    } else if (cur !== 'EUR') throw new RangeError('currency');
    if (zeroConfUpToCents === 0) return 1;
    if (cents > high) return 1;
    if (qcOk) return 0;
    return cents > fb ? 1 : 0;
  }
  if (!Number.isSafeInteger(sats) || sats < 1 || sats > MAX_SATS) throw new RangeError('sats');
  if (confirmFromSats != null) {
    if (!Number.isSafeInteger(confirmFromSats) || confirmFromSats < 0 || confirmFromSats > MAX_SATS) throw new RangeError('confirmFromSats');
    return sats >= confirmFromSats ? 1 : 0;
  }
  if (zeroConfUpToCents === 0) return 1;
  const high = eurToSatsFloor(zeroConfUpToCents, eurRate), fb = eurToSatsFloor(fallbackZeroConfUpToCents, eurRate);
  if (high == null || fb == null) return 1;
  if (sats > high) return 1;
  if (qcOk) return 0;
  return sats > fb ? 1 : 0;
}

/** Current fiat rate on YOUR server: CoinGecko (EUR, USD) first. Backup: USD = WhatsOnChain; EUR = WhatsOnChain USD divided by
 *  the official ECB EUR/USD reference rate (daily XML, cached 1 h). Refuses stale data. backup: false = CoinGecko only. */
export async function fetchRate(currency, { fetchImpl = fetch, now = Math.floor(Date.now() / 1000), cgUrl = CG, wocBase = WOC, ecbUrl = ECB_XML, backup = true } = {}) {
  const cur = String(currency || '').toUpperCase();
  if (cur !== 'EUR' && cur !== 'USD') throw new RangeError('currency');
  const fresh = (v, t, source) => { const m = rateMicro(v), ts = Number(t);
    return m != null && Number.isSafeInteger(ts) && ts > 0 && now - ts <= RATE_MAX_AGE_S && ts - now <= RATE_FUTURE_S ? { rate: m / 1e6, rateTime: ts, source } : null; };
  try { const j = await getJson(cgUrl, fetchImpl); const o = j.body && j.body['bitcoin-cash-sv'];
    const r = o && fresh(o[cur.toLowerCase()], o.last_updated_at, 'coingecko'); if (r) return r; } catch (e) { /* fall through */ }
  if (!backup) throw new Error('no_fresh_rate');
  let usd = null;
  try { const j = await getJson(wocBase + '/exchangerate', fetchImpl); usd = j.body && j.body.currency === 'USD' && fresh(j.body.rate, j.body.time, 'whatsonchain') || null; } catch (e) { /* none */ }
  if (usd && cur === 'USD') return usd;
  if (usd) {
    try { const e = await fetchEcb(fetchImpl, now, ecbUrl);
      const r = fresh(usd.rate / e.usdPerEur, usd.rateTime, 'whatsonchain+ecb');
      if (r) return { ...r, usdRate: usd.rate, ecbRate: e.usdPerEur, ecbDate: e.date }; } catch (e) { /* none */ }
  }
  throw new Error('no_fresh_rate');
}

/** Server-made quote (recommended): the SERVER decides the exact amount incl. a random tag that is unique among open
 *  orders, so a stranger's payment can never be claimed for another order. Render the button with
 *  data-amount="<amountBsv>" data-unique="0" data-order-id="<your id>" data-expires-min="<n>" and verify with exactSats. */
export function createQuote({ cents, rate, currency, rateTime, expiresMin = 15, tagMax = 999, openSats = new Set(), now = Math.floor(Date.now() / 1000) } = {}) {
  if (!Number.isInteger(expiresMin) || expiresMin < 1 || expiresMin > 60) throw new RangeError('expiresMin');
  if (!Number.isInteger(tagMax) || tagMax < 1 || tagMax > 100000) throw new RangeError('tagMax');
  const baseSats = fiatToSats(cents, rate);
  for (let i = 0; i < 64; i++) {
    const tag = randomInt(1, tagMax + 1), sats = baseSats + tag;
    if (sats > MAX_SATS) throw new RangeError('sats');
    if (!openSats.has(sats)) return { sats, amountBsv: fmtBsv(sats), baseSats, tag, cents, currency, rate, rateTime, createdAt: now, expiresAt: now + expiresMin * 60 };
  }
  throw new Error('no_free_tag');   // too many open orders with the same price: raise tagMax
}

/** Minimal in-memory claims store (for tests / a single process). In production use your database:
 *  UNIQUE(txid) and "INSERT … ON CONFLICT DO NOTHING", then compare the stored order id. */
/** true only for a result object returned by runQuickCheck() in this process */
export function isTrustedQuickCheck(q) { return !!q && typeof q === 'object' && TRUSTED_QC.has(q); }
function qcResult(o) { const r = Object.freeze({ ...o }); TRUSTED_QC.add(r); return r; }
const QC_OK_PROBE = qcResult({ ok: true, probe: true });   // internal only: the policy if a check passed
function qcStatus(j) {
  if (!j || typeof j !== 'object') return { missing: true };
  const st = String(j.txStatus || ''), competing = Array.isArray(j.competingTxs) && j.competingTxs.length > 0;
  if (competing || QC_BAD.has(st) || /ORPHAN/i.test(st + String(j.extraInfo || ''))) return { bad: true, txStatus: st, competing };
  return { ok: QC_GOOD.has(st), txStatus: st };
}
/**
 * Server-side quick check (same rule as the button, run on YOUR server so the buyer cannot fake it):
 * the tx is final, pays at least the Broadcaster fee policy (parents loaded from your source and hash-checked),
 * is re-submitted to BSV Broadcaster and stays SEEN_ON_NETWORK / MINED / IMMUTABLE with no competingTxs for watchMs (default 5 s).
 * Resolves a frozen result { ok, reason?, txStatus?, endpoint?, fee?, satPerKb? }. Pass it to verifyPayment({ quickCheck })
 * or requiredConfirmations({ quickCheck }), or simply call verifyPayment({ ..., quickCheck: 'run' }).
 * hard = true means the payment must wait for a block (not final, low fee, double-spend or rejected).
 */
export async function runQuickCheck({ txid, hex, source, fetchImpl, broadcasters = BROADCASTERS, watchMs = 5000, pollMs = 1000,
  now = Math.floor(Date.now() / 1000), tipHeight, maxInputs = 20 } = {}) {
  const f = fetchImpl || fetch;
  txid = typeof txid === 'string' ? txid.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(txid)) return qcResult({ ok: false, reason: 'bad_input' });
  if (!Array.isArray(broadcasters) || !broadcasters.length || broadcasters.some((u) => typeof u !== 'string' || !/^(https:\/\/[^\s/]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^\s]*)?)$/.test(u))) return qcResult({ ok: false, reason: 'bad_input' });
  if (!(Number.isInteger(watchMs) && watchMs >= 3000 && watchMs <= 15000)) return qcResult({ ok: false, reason: 'bad_input' });
  if (hex == null) {
    let t; try { t = await loadTx(txid, source, f); } catch (e) { return qcResult({ ok: false, reason: 'source_error' }); }
    if (t.status !== 200) return qcResult({ ok: false, reason: 'source_error' });
    hex = t.hex;
  }
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex) || txidFromRaw(hex) !== txid) return qcResult({ ok: false, reason: 'hex' });
  let tx; try { tx = parseRawTx(hex); } catch (e) { return qcResult({ ok: false, reason: 'hex' }); }
  if (!isTxFinal(tx, now, tipHeight)) return qcResult({ ok: false, reason: 'not_final', hard: true });
  if (tx.inputs.length > maxInputs) return qcResult({ ok: false, reason: 'fee_unknown' });
  let inS = 0;
  for (const inp of tx.inputs) {
    let p; try { p = await loadTx(inp.prevTxid, source, f); } catch (e) { p = null; }
    if (!p || p.status !== 200 || !/^[0-9a-fA-F]+$/.test(p.hex || '') || txidFromRaw(p.hex) !== inp.prevTxid) return qcResult({ ok: false, reason: 'fee_unknown' });
    let ptx; try { ptx = parseRawTx(p.hex); } catch (e) { return qcResult({ ok: false, reason: 'fee_unknown' }); }
    const out = ptx.outputs[inp.vout]; if (!out) return qcResult({ ok: false, reason: 'bad_amounts', hard: true });
    inS += out.sats;
  }
  const outS = tx.outputs.reduce((a, o) => a + o.sats, 0);
  if (inS < outS) return qcResult({ ok: false, reason: 'bad_amounts', hard: true });
  const fee = inS - outS, size = hex.length / 2;
  let satPerKb = DEFAULT_FEE_SAT_PER_KB;
  for (const root of broadcasters) {
    const j = await getJson(root + '/policy', f).catch(() => null);
    const mf = j && j.status === 200 && j.body && j.body.policy && j.body.policy.miningFee;
    if (mf && Number(mf.satoshis) >= 1 && Number(mf.bytes) >= 1) { satPerKb = Math.ceil(Number(mf.satoshis) * 1000 / Number(mf.bytes)); break; }
  }
  if (!feeSufficient(fee, size, satPerKb)) return qcResult({ ok: false, reason: 'low_fee', hard: true, fee, satPerKb, size });
  const started = Date.now();
  for (const root of broadcasters) {
    let r;
    try { r = await f(root + '/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: hex, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
    catch (e) { continue; }
    let body = null; try { body = JSON.parse(await r.text()); } catch (e) { body = null; }
    if (!r.ok) continue;
    let last = qcStatus(body);
    while (!last.bad && Date.now() - started < watchMs) {
      await new Promise((res) => setTimeout(res, pollMs));
      const j = await getJson(root + '/tx/' + txid, f).catch(() => null);
      last = j && j.status === 200 ? qcStatus(j.body) : { error: true };
    }
    if (last.bad) return qcResult({ ok: false, reason: 'double_spend', hard: true, txStatus: last.txStatus, endpoint: root });
    if (last.ok) return qcResult({ ok: true, txStatus: last.txStatus, endpoint: root, fee, satPerKb, size });
    return qcResult({ ok: false, reason: 'arc_pending', txStatus: last.txStatus, endpoint: root });
  }
  return qcResult({ ok: false, reason: 'arc_unavailable' });
}

export class MemoryClaims {
  constructor() { this.m = new Map(); }
  async claim(txid, orderId) { const c = this.m.get(txid); if (c === undefined) { this.m.set(txid, orderId); return true; } return c === orderId; }
}

async function loadTx(txid, source, f) {
  if (source && source.rpc) {
    const { url, user, password } = source.rpc;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw Object.assign(new Error('bad rpc url'), { code: 'bad_input' });
    const headers = { 'Content-Type': 'application/json' };
    if (user != null) headers.Authorization = 'Basic ' + Buffer.from(user + ':' + (password || '')).toString('base64');
    const r = await f(url, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: '1.0', id: 'kallubi-verify', method: 'getrawtransaction', params: [txid, 1] }) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* below */ }
    if (j && j.error && (j.error.code === -5)) return { status: 404 };          // no such tx (mempool / index)
    if (!r.ok || !j || j.error || !j.result) return { status: r.status || 502 };
    return { status: 200, hex: String(j.result.hex || ''), confirmations: Number(j.result.confirmations) || 0, blocktime: Number(j.result.blocktime) || 0, statusOk: true, source: 'rpc' };
  }
  const base = (source && source.woc) || WOC;
  const headers = source && source.apiKey ? { 'woc-api-key': source.apiKey } : {};
  const r = await f(base + '/tx/' + txid + '/hex', { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return { status: 404 };
  if (!r.ok) return { status: r.status };
  const hex = (await r.text()).trim().replace(/^"|"$/g, '');
  // status only (confirmations / block time); amounts never come from this JSON
  const s = await getJson(base + '/tx/hash/' + txid, f, headers).catch(() => ({ status: 502 }));
  const st = s.status === 200 && s.body ? s.body : {};
  const statusOk = s.status === 200 && !!s.body && String(s.body.txid || s.body.hash || '').toLowerCase() === txid;
  return { status: 200, hex, confirmations: statusOk ? Number(st.confirmations) || 0 : 0, blocktime: statusOk ? Number(st.blocktime) || 0 : 0, statusOk, source: 'whatsonchain' };
}

/**
 * verifyPayment({ txid, address, exactSats | minSats, orderId, claims, orderCents?, zeroConfUpToCents?, confirmFromSats?,
 *                 createdAt?, expiresAt?, minConfirmations?, acceptLate?,
 *                 seenAt?, lateGraceS?, source?: { woc?: baseUrl, apiKey? } | { rpc: { url, user, password } }, fetchImpl? })
 * -> { ok, status, txid, orderId, paidSats, expectedSats, confirmations, requiredConfirmations, blocktime, late, source }
 * orderCents = the fiat price of the order (recommended for fiat orders): up to zeroConfUpToCents (default 2000) 0-conf,
 * above 1 confirmation. Without orderCents the BSV rule applies (from confirmFromSats, default 0.01 BSV, 1 confirmation).
 * status: 'paid' (ok) | 'pending' (not enough confirmations / not found yet, ask again later) | 'underpaid' | 'overpaid' |
 *         'late' | 'too_old' | 'already_used' | 'txid_mismatch' | 'bad_tx' | 'not_found' | 'source_error' | 'bad_input'
 * Only ok === true means: deliver the order.
 */
export async function verifyPayment(o = {}) {
  const f = o.fetchImpl || fetch;
  const txid = typeof o.txid === 'string' ? o.txid.toLowerCase() : '';
  const base = { ok: false, txid: txid || null, orderId: o.orderId == null ? null : String(o.orderId) };
  const bad = (reason) => ({ ...base, status: 'bad_input', reason });
  if (!/^[0-9a-f]{64}$/.test(txid)) return bad('txid');
  const script = addressToScript(o.address); if (!script) return bad('address');
  const exact = o.exactSats != null, expected = exact ? o.exactSats : o.minSats;
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_SATS) return bad(exact ? 'exactSats' : 'minSats');
  if (typeof base.orderId !== 'string' || !base.orderId || base.orderId.length > 128) return bad('orderId');
  if (!o.claims || typeof o.claims.claim !== 'function') return bad('claims');          // replay protection is not optional
  const askConf = o.minConfirmations == null ? 0 : o.minConfirmations;
  if (!Number.isInteger(askConf) || askConf < 0 || askConf > 100) return bad('minConfirmations');
  // quickCheck: undefined | 'run' (run the quick check here, on your server) | a result of runQuickCheck().
  // Anything else (e.g. detail.quickCheck from the browser event) is refused: the buyer controls the browser.
  const runQc = o.quickCheck === 'run';
  if (o.quickCheck != null && !runQc && !isTrustedQuickCheck(o.quickCheck)) return bad('quickCheck');
  const givenQc = runQc ? undefined : o.quickCheck;
  let policy, policyWithQc;
  try { policyWithQc = requiredConfirmations({
    cents: o.orderCents == null ? undefined : o.orderCents, sats: expected,
    currency: o.currency, usdPerEur: o.usdPerEur, eurRate: o.eurRate, quickCheck: QC_OK_PROBE,
    zeroConfUpToCents: o.zeroConfUpToCents == null ? undefined : o.zeroConfUpToCents,
    fallbackZeroConfUpToCents: o.fallbackZeroConfUpToCents == null ? undefined : o.fallbackZeroConfUpToCents,
    confirmFromSats: o.confirmFromSats == null ? undefined : o.confirmFromSats }); }
  catch (e) { return bad(e.message); }
  try { policy = requiredConfirmations({
    cents: o.orderCents == null ? undefined : o.orderCents, sats: expected,
    currency: o.currency, usdPerEur: o.usdPerEur, eurRate: o.eurRate, quickCheck: givenQc,
    zeroConfUpToCents: o.zeroConfUpToCents == null ? undefined : o.zeroConfUpToCents,
    fallbackZeroConfUpToCents: o.fallbackZeroConfUpToCents == null ? undefined : o.fallbackZeroConfUpToCents,
    confirmFromSats: o.confirmFromSats == null ? undefined : o.confirmFromSats }); }
  catch (e) { return bad(e.message); }
  let minConf = Math.max(askConf, policy);     // the policy is a floor: minConfirmations can only make it stricter
  if (givenQc && givenQc.hard) minConf = Math.max(minConf, 1);   // a failed check (not final, low fee, double-spend) always waits
  for (const k of ['createdAt', 'expiresAt', 'seenAt']) if (o[k] != null && !(Number.isSafeInteger(o[k]) && o[k] > 0)) return bad(k);
  const now = o.seenAt || Math.floor(Date.now() / 1000), grace = Number.isInteger(o.lateGraceS) && o.lateGraceS >= 0 ? o.lateGraceS : 0;

  let t;
  try { t = await loadTx(txid, o.source, f); } catch (e) { return e && e.code === 'bad_input' ? bad('source') : { ...base, status: 'source_error' }; }
  if (t.status === 404) return { ...base, status: 'not_found' };
  if (t.status !== 200) return { ...base, status: 'source_error', http: t.status };
  if (!/^[0-9a-fA-F]+$/.test(t.hex) || txidFromRaw(t.hex) !== txid) return { ...base, status: 'txid_mismatch' };
  let tx; try { tx = parseRawTx(t.hex); } catch (e) { return { ...base, status: 'bad_tx', reason: e.message }; }
  // A non-final transaction (nSequence / nLockTime) must not be accepted at 0-conf.
  if ((t.confirmations || 0) < 1 && !isTxFinal(tx, now, o.tipHeight)) minConf = Math.max(minConf, 1);
  let paid = 0; for (const out of tx.outputs) if (out.script.toLowerCase() === script) paid += out.sats;
  let quickCheck = givenQc || null;
  if (runQc && (t.confirmations || 0) < 1 && paid >= expected && minConf > 0 && Math.max(askConf, policyWithQc) === 0 && isTxFinal(tx, now, o.tipHeight)) {
    quickCheck = await runQuickCheck({ txid, hex: t.hex, source: o.source, fetchImpl: f, now, tipHeight: o.tipHeight,
      broadcasters: o.broadcasters || BROADCASTERS, watchMs: o.quickWatchMs || 5000 });
    if (quickCheck.ok) minConf = 0;
    else if (quickCheck.hard) minConf = Math.max(minConf, 1);
  }
  // fail closed: without a status answer we cannot check age or confirmations
  if (!t.statusOk && (o.createdAt || minConf > 0)) return { ...base, status: 'source_error', reason: 'status_unavailable' };
  const info = { ...base, quickCheck: quickCheck || undefined, paidSats: paid, expectedSats: expected, confirmations: t.confirmations, requiredConfirmations: minConf, blocktime: t.blocktime || null, source: t.source, final: isTxFinal(tx, now, o.tipHeight) };
  if (paid < expected) return { ...info, status: 'underpaid' };
  if (exact && paid > expected) return { ...info, status: 'overpaid' };          // exact amount is the order binding; review by hand
  if (o.createdAt && t.blocktime && t.blocktime < o.createdAt - OLD_SLACK_S) return { ...info, status: 'too_old' };
  if (t.confirmations < minConf) return { ...info, status: 'pending' };
  let late = false;
  if (o.expiresAt) {
    const minedInTime = t.confirmations > 0 && t.blocktime && t.blocktime <= o.expiresAt + grace;
    late = !(now <= o.expiresAt + grace || minedInTime);
  }
  if (late && !o.acceptLate) return { ...info, late, status: 'late' };
  if (!(await o.claims.claim(txid, base.orderId))) return { ...info, late, status: 'already_used' };
  return { ...info, late, ok: true, status: 'paid' };
}
