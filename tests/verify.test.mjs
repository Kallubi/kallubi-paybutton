// Tests for verify/kallubi-verify.mjs (server-side payment check). Mocked chain + rate sources, no real transactions.
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as V from '../verify/kallubi-verify.mjs';

const results = []; const ok = (n) => { results.push(['PASS', n]); console.log('PASS', n); };
const t = async (name, fn) => { try { await fn(); ok(name); } catch (e) { results.push(['FAIL', name]); console.log('FAIL', name, '-', e.message); process.exitCode = 1; } };
const ADDR = '1111111111111111111114oLvT2', SCRIPT = '76a914' + '00'.repeat(20) + '88ac';
const OTHER = '76a914' + '11'.repeat(20) + '88ac';
const sha = (b) => createHash('sha256').update(b).digest();
const varint = (n) => n < 0xfd ? Buffer.from([n]) : (() => { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; })();
function rawTx(outs, { inputs = 1, extra = '' } = {}) {
  const parts = [Buffer.from('01000000', 'hex'), varint(inputs)];
  for (let i = 0; i < inputs; i++) { parts.push(randomBytes(32), Buffer.from('00000000', 'hex')); const sig = randomBytes(106); parts.push(varint(sig.length), sig, Buffer.from('ffffffff', 'hex')); }
  parts.push(varint(outs.length));
  for (const [sats, script] of outs) { const v = Buffer.alloc(8); v.writeBigUInt64LE(BigInt(sats)); const s = Buffer.from(script, 'hex'); parts.push(v, varint(s.length), s); }
  parts.push(Buffer.from('00000000', 'hex'));
  return Buffer.concat(parts).toString('hex') + extra;
}
const txid = (hex) => Buffer.from(sha(sha(Buffer.from(hex, 'hex')))).reverse().toString('hex');

// tx spending vout 0 of a known parent (for the server-side quick check: the fee needs the parent)
function rawTxFrom(prevId, outs, { sequence = 'ffffffff', locktime = '00000000' } = {}) {
  const parts = [Buffer.from('01000000', 'hex'), varint(1), Buffer.from(prevId, 'hex').reverse(), Buffer.from('00000000', 'hex')];
  const sig = randomBytes(106); parts.push(varint(sig.length), sig, Buffer.from(sequence, 'hex'));
  parts.push(varint(outs.length));
  for (const [sats, script] of outs) { const v = Buffer.alloc(8); v.writeBigUInt64LE(BigInt(sats)); const s = Buffer.from(script, 'hex'); parts.push(v, varint(s.length), s); }
  parts.push(Buffer.from(locktime, 'hex'));
  return Buffer.concat(parts).toString('hex');
}
const BC = { down: false, status: new Map(), posts: 0 };   // mock BSV Broadcaster: txid -> {txStatus, competingTxs}
// ---- mock WhatsOnChain + JSON-RPC node
const TX = new Map();          // txid -> { hex, confirmations, blocktime, lie }
let woc429 = false, statusDown = false, rpcAuth = null;
const srv = http.createServer((q, r) => {
  let m;
  if (q.method === 'POST' && q.url === '/rpc') {
    let body = ''; q.on('data', (c) => body += c); q.on('end', () => {
      rpcAuth = q.headers.authorization || null;
      const j = JSON.parse(body), e = TX.get(j.params[0]);
      r.writeHead(e ? 200 : 500, { 'Content-Type': 'application/json' });
      r.end(JSON.stringify(e ? { result: { hex: e.hex, confirmations: e.confirmations, blocktime: e.blocktime }, error: null, id: j.id } : { result: null, error: { code: -5, message: 'No such mempool or blockchain transaction' }, id: j.id }));
    }); return;
  }
  if (q.url.startsWith('/bc/')) {
    if (BC.down) { r.writeHead(503); return r.end(); }
    if (q.url === '/bc/policy') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ policy: { miningFee: { satoshis: 100, bytes: 1000 } } })); }
    if (q.method === 'POST' && q.url === '/bc/tx') {
      let body = ''; q.on('data', (c) => body += c); q.on('end', () => {
        BC.posts++; const id = txid(body.trim()); const st = BC.status.get(id) || { txStatus: 'SEEN_ON_NETWORK' };
        r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ txid: id, ...st }));
      }); return;
    }
    if ((m = q.url.match(/^\/bc\/tx\/([0-9a-f]{64})$/))) { const st = BC.status.get(m[1]) || { txStatus: 'SEEN_ON_NETWORK' }; r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ txid: m[1], ...st })); }
    r.writeHead(404); return r.end();
  }
  if (woc429) { r.writeHead(429); return r.end('<html>429</html>'); }
  if ((m = q.url.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) { const e = TX.get(m[1]); if (!e) { r.writeHead(404); return r.end(); } r.writeHead(200); return r.end(e.serve || e.hex); }
  if ((m = q.url.match(/^\/tx\/hash\/([0-9a-f]{64})$/))) {
    const e = TX.get(m[1]); if (!e || statusDown) { r.writeHead(statusDown ? 503 : 404); return r.end(); }
    r.writeHead(200, { 'Content-Type': 'application/json' });
    // the JSON "lies" about the amount on purpose: the verifier must ignore vout values here and use the raw bytes
    return r.end(JSON.stringify({ txid: m[1], confirmations: e.confirmations, blocktime: e.blocktime, vout: [{ value: 999, scriptPubKey: { hex: SCRIPT } }] }));
  }
  r.writeHead(404); r.end();
});
await new Promise((res) => srv.listen(0, '127.0.0.1', res));
const BASE = 'http://127.0.0.1:' + srv.address().port;
const src = { woc: BASE };
const now = Math.floor(Date.now() / 1000);
const put = (outs, extra = {}) => { const hex = rawTx(outs); const id = txid(hex); TX.set(id, { hex, confirmations: 0, blocktime: 0, ...extra }); return id; };
const BCS = [BASE + '/bc'];
// a trusted, passed quick check (made by runQuickCheck against the mock Broadcaster)
const QPARENT = put([[300000, OTHER]], { confirmations: 3, blocktime: now - 3600 });
const QCHILD_HEX = rawTxFrom(QPARENT, [[290000, OTHER]]); const QCHILD = txid(QCHILD_HEX); TX.set(QCHILD, { hex: QCHILD_HEX, confirmations: 0, blocktime: 0 });
const QC_OK = await V.runQuickCheck({ txid: QCHILD, source: { woc: BASE }, broadcasters: BCS, watchMs: 3000, pollMs: 200 });
const verify = (o) => V.verifyPayment({ address: ADDR, orderId: 'O-1', claims: new V.MemoryClaims(), source: src, createdAt: now - 60, expiresAt: now + 840, eurRate: 20, ...o });

// ---- address + parser
await t('address: mainnet P2PKH -> script; genesis hash160 correct', () => {
  assert.equal(V.addressToScript(ADDR), SCRIPT);
  assert.equal(V.addressToScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac');
});
await t('address: bad checksum / P2SH / testnet / bech32 / html -> null', () => {
  for (const a of ['1111111111111111111114oLvT3', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', '<script>', '', null]) assert.equal(V.addressToScript(a), null);
});
await t('parser: outputs, inputs, txid round-trip', () => {
  const hex = rawTx([[1234, SCRIPT], [0, '006a0b6b616c6c7562692d746573'], [5, OTHER]], { inputs: 2 });
  const p = V.parseRawTx(hex);
  assert.equal(p.version, 1); assert.equal(p.inputs.length, 2); assert.deepEqual(p.outputs.map((o) => o.sats), [1234, 0, 5]); assert.equal(p.outputs[0].script, SCRIPT);
  assert.equal(V.txidFromRaw(hex), txid(hex));
});
await t('parser: rejects truncated, trailing bytes, odd hex, non-hex, zero inputs/outputs, huge varint, value > 21M BSV', () => {
  const hex = rawTx([[1234, SCRIPT]]);
  for (const bad of [hex.slice(0, -2), hex + '00', hex + '0', 'zz' + hex, '', '01000000' + '00' + '00' + '00000000', '01000000' + 'ff' + 'ffffffffffffffff',
    rawTx([[2100000000000001, SCRIPT]]), rawTx([[2100000000000000, SCRIPT], [1, SCRIPT]])]) assert.throws(() => V.parseRawTx(bad));
});

// ---- verifyPayment
await t('verify: exact amount to the shop address -> ok/paid', async () => {
  const id = put([[50037, SCRIPT], [9000, OTHER]]);
  const r = await verify({ txid: id, exactSats: 50037 });
  assert.equal(r.ok, true); assert.equal(r.status, 'paid'); assert.equal(r.paidSats, 50037); assert.equal(r.source, 'whatsonchain');
});
await t('verify: amounts come from the raw bytes, not from the source JSON (JSON claims 999 BSV)', async () => {
  const id = put([[100, SCRIPT]]);
  const r = await verify({ txid: id, minSats: 50000 });
  assert.equal(r.ok, false); assert.equal(r.status, 'underpaid'); assert.equal(r.paidSats, 100);
});
await t('verify: underpaid by 1 sat -> underpaid; overpaid with exactSats -> overpaid (manual review); minSats accepts more', async () => {
  const id = put([[50036, SCRIPT]]); assert.equal((await verify({ txid: id, exactSats: 50037 })).status, 'underpaid');
  const id2 = put([[50038, SCRIPT]]); assert.equal((await verify({ txid: id2, exactSats: 50037 })).status, 'overpaid');
  assert.equal((await verify({ txid: id2, minSats: 50037 })).ok, true);
});
await t('verify: several outputs to the shop are summed; outputs to other addresses ignored', async () => {
  const id = put([[30000, SCRIPT], [20037, SCRIPT], [99999999, OTHER]]);
  const r = await verify({ txid: id, exactSats: 50037 }); assert.equal(r.ok, true); assert.equal(r.paidSats, 50037);
});
await t('verify: source returns the hex of a DIFFERENT tx -> txid_mismatch (tampered source)', async () => {
  const id = put([[50037, SCRIPT]]); TX.get(id).serve = rawTx([[50037, SCRIPT]]);
  assert.equal((await verify({ txid: id, exactSats: 50037 })).status, 'txid_mismatch');
});
await t('verify: replay - the same txid cannot pay a second order; same order again is idempotent', async () => {
  const claims = new V.MemoryClaims(); const id = put([[50037, SCRIPT]]);
  assert.equal((await verify({ txid: id, exactSats: 50037, claims, orderId: 'A' })).ok, true);
  assert.equal((await verify({ txid: id, exactSats: 50037, claims, orderId: 'A' })).ok, true);
  const r = await verify({ txid: id, exactSats: 50037, claims, orderId: 'B' }); assert.equal(r.ok, false); assert.equal(r.status, 'already_used');
});
await t('verify: tx older than the order (block time < createdAt - 2 h) -> too_old', async () => {
  const id = put([[50037, SCRIPT]], { confirmations: 50, blocktime: now - 86400 });
  assert.equal((await verify({ txid: id, exactSats: 50037 })).status, 'too_old');
});
await t('verify: minConfirmations - 0 conf -> pending, 1 conf -> paid', async () => {
  const id = put([[50037, SCRIPT]]); assert.equal((await verify({ txid: id, exactSats: 50037, minConfirmations: 1 })).status, 'pending');
  TX.get(id).confirmations = 1; TX.get(id).blocktime = now; assert.equal((await verify({ txid: id, exactSats: 50037, minConfirmations: 1 })).ok, true);
});
await t('verify: expiry - seen after expiresAt (unconfirmed) -> late; boundary second is on time; acceptLate -> ok with late=true', async () => {
  const id = put([[50037, SCRIPT]]);
  const exp = now - 10;
  assert.equal((await verify({ txid: id, exactSats: 50037, expiresAt: exp, seenAt: exp + 1 })).status, 'late');
  assert.equal((await verify({ txid: id, exactSats: 50037, expiresAt: exp, seenAt: exp })).ok, true);
  const r = await verify({ txid: id, exactSats: 50037, expiresAt: exp, seenAt: exp + 1, acceptLate: true }); assert.equal(r.ok, true); assert.equal(r.late, true);
});
await t('verify: verified late but mined before expiry -> on time', async () => {
  const id = put([[50037, SCRIPT]], { confirmations: 2, blocktime: now - 100 });
  const r = await verify({ txid: id, exactSats: 50037, expiresAt: now - 50, seenAt: now }); assert.equal(r.ok, true); assert.equal(r.late, false);
});
await t('verify: unknown tx -> not_found; WoC 429 -> source_error; status lookup down -> fail closed', async () => {
  assert.equal((await verify({ txid: 'ab'.repeat(32), exactSats: 1 })).status, 'not_found');
  woc429 = true; const id = put([[50037, SCRIPT]]); assert.equal((await verify({ txid: id, exactSats: 50037 })).status, 'source_error'); woc429 = false;
  statusDown = true; const r = await verify({ txid: id, exactSats: 50037 }); assert.equal(r.status, 'source_error'); assert.equal(r.reason, 'status_unavailable'); statusDown = false;
});
await t('verify v1.3.0: confirmed tx without block time (age unknown) -> fail closed (source_error blocktime_unavailable), never paid', async () => {
  const id = put([[50037, SCRIPT]], { confirmations: 2, blocktime: 0 });
  const r = await verify({ txid: id, exactSats: 50037 }); assert.equal(r.status, 'source_error'); assert.equal(r.reason, 'blocktime_unavailable'); assert.ok(!r.ok);
});
await t('verify: bad input is refused before any network call (txid, address, amount, orderId, no claims store, minConfirmations)', async () => {
  const id = put([[50037, SCRIPT]]);
  const cases = [{ txid: 'xyz', exactSats: 1 }, { txid: id, exactSats: 1, address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' }, { txid: id, exactSats: 0 }, { txid: id, exactSats: 1.5 }, { txid: id },
    { txid: id, exactSats: 1, orderId: '' }, { txid: id, exactSats: 1, claims: null }, { txid: id, exactSats: 1, minConfirmations: -1 }, { txid: id, exactSats: 1, createdAt: 'yesterday' }];
  for (const c of cases) assert.equal((await verify(c)).status, 'bad_input', JSON.stringify(c));
});
await t('verify: own node via JSON-RPC (basic auth sent, never logged); missing tx -> not_found', async () => {
  const id = put([[50037, SCRIPT]], { confirmations: 3, blocktime: now });
  const rpc = { rpc: { url: BASE + '/rpc', user: 'shop', password: 'example-only' } };
  const r = await verify({ txid: id, exactSats: 50037, source: rpc, minConfirmations: 1 });
  assert.equal(r.ok, true); assert.equal(r.source, 'rpc'); assert.equal(rpcAuth, 'Basic ' + Buffer.from('shop:example-only').toString('base64'));
  assert.ok(!JSON.stringify(r).includes('example-only'));
  assert.equal((await verify({ txid: 'cd'.repeat(32), exactSats: 1, source: rpc })).status, 'not_found');
});

// ---- fiat + quotes
await t('fiat: same vectors as the button (25.00@12.67=197316496, 0.01@3=333334, 10.00@14.25=70175439, 25.00@13=192307693)', () => {
  assert.equal(V.fiatToSats(2500, 12.67), 197316496); assert.equal(V.fiatToSats(1, 3), 333334); assert.equal(V.fiatToSats(1000, 14.25), 70175439); assert.equal(V.fiatToSats(2500, '13.00'), 192307693);
  assert.equal(V.fiatToSats(100000000, 1), 100000000000000);
  for (const [c, r] of [[0, 1], [1.5, 1], [100, 0], [100, -1], [100, '1e3'], [100, NaN], [100000000, 0.000001]]) assert.throws(() => V.fiatToSats(c, r));
});
await t('quote: server-made exact amount with a random tag unique among open orders', () => {
  const open = new Set(); const q = V.createQuote({ cents: 2500, rate: 12.67, currency: 'EUR', now: 1000 });
  assert.ok(q.tag >= 1 && q.tag <= 999 && q.sats === 197316496 + q.tag && q.amountBsv === V.fmtBsv(q.sats) && q.expiresAt === 1900);
  for (let i = 0; i < 9; i++) open.add(197316496 + i + 1);
  const q2 = V.createQuote({ cents: 2500, rate: 12.67, tagMax: 10, openSats: open }); assert.equal(q2.tag, 10);
  open.add(197316506); assert.throws(() => V.createQuote({ cents: 2500, rate: 12.67, tagMax: 10, openSats: open }), /no_free_tag/);
  assert.throws(() => V.createQuote({ cents: 2500, rate: 12.67, expiresMin: 0 }));
});
await t('rate: CoinGecko fresh -> used; stale -> refused for EUR; USD falls back to WhatsOnChain; nothing fresh -> throws', async () => {
  const mk = (cg, woc) => async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.includes('coingecko') ? cg : woc) });
  const n = 1800000000;
  // pre-1.3 single-source behaviour is now the explicit opt-in minSources: 1
  assert.deepEqual(await V.fetchRate('EUR', { now: n, minSources: 1, fetchImpl: mk({ 'bitcoin-cash-sv': { eur: 12.67, usd: 13.9, last_updated_at: n - 30 } }) }), { rate: 12.67, rateTime: n - 30, source: 'coingecko', sources: 1 });
  await assert.rejects(V.fetchRate('EUR', { now: n, fetchImpl: mk({ 'bitcoin-cash-sv': { eur: 12.67, last_updated_at: n - 601 } }, { rate: 14, time: n, currency: 'USD' }) }));
  assert.equal((await V.fetchRate('USD', { now: n, minSources: 1, fetchImpl: mk({ 'bitcoin-cash-sv': { usd: 0, last_updated_at: n } }, { rate: 14.25, time: n - 5, currency: 'USD' }) })).source, 'whatsonchain');
  await assert.rejects(V.fetchRate('USD', { now: n, fetchImpl: mk({ 'bitcoin-cash-sv': { usd: 0, last_updated_at: n } }, { rate: 14.25, time: n - 5, currency: 'USD' }) }), /single_rate_source/);
  await assert.rejects(V.fetchRate('USD', { now: n, fetchImpl: mk({}, { rate: 14.25, time: n - 900, currency: 'USD' }) }));
  await assert.rejects(V.fetchRate('GBP', { now: n, fetchImpl: mk({}, {}) }));
});
// ---- v1.3.0 rate-check: two sources must agree
await t('v1.3.0 rate: CoinGecko + WhatsOnChain agree (<= 3 %) -> CoinGecko rate, checkedBy; 5 % apart -> rate_mismatch; bounds 0.5..100000', async () => {
  const n = 1800000000;
  const mk = (cgUsd, wocUsd) => async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.includes('coingecko')
    ? { 'bitcoin-cash-sv': { usd: cgUsd, eur: cgUsd, last_updated_at: n - 20 } } : { rate: wocUsd, time: n - 5, currency: 'USD' }) });
  const r = await V.fetchRate('USD', { now: n, fetchImpl: mk(14.0, 14.3) });
  assert.equal(r.rate, 14); assert.equal(r.source, 'coingecko'); assert.equal(r.checkedBy, 'whatsonchain'); assert.equal(r.sources, 2);
  await assert.rejects(V.fetchRate('USD', { now: n, fetchImpl: mk(14.0, 14.7) }), /rate_mismatch/);      // 5 % apart
  await assert.rejects(V.fetchRate('USD', { now: n, minSources: 1, fetchImpl: mk(14.0, 14.7) }), /rate_mismatch/);   // disagreement is never ignored
  await assert.rejects(V.fetchRate('USD', { now: n, fetchImpl: mk(1.4, 14.0) }), /rate_mismatch/);       // one source 10x off (manipulated / bad data)
  assert.equal(V.ratesAgree(100, 103), true); assert.equal(V.ratesAgree(100, 103.01), false);
  assert.equal(V.rateMicro(0.49), null); assert.equal(V.rateMicro(100001), null); assert.equal(V.rateMicro(100000), 100000000000);
  await assert.rejects(V.fetchRate('USD', { now: n, minSources: 3, fetchImpl: mk(14, 14) }), RangeError);
});
await t('fiat: minSatsFromFiat = price at the server rate minus tolerance (2 % default), refuses silly tolerances', () => {
  assert.equal(V.minSatsFromFiat(2500, 12.67), Math.floor(197316496 * 0.98)); assert.equal(V.minSatsFromFiat(2500, 12.67, 0), 197316496);
  assert.throws(() => V.minSatsFromFiat(2500, 12.67, 50)); assert.throws(() => V.minSatsFromFiat(2500, 12.67, -1));
});
// ---- v1.2.0: EUR backup (WhatsOnChain USD x ECB EUR/USD) + confirmation policy
const ecbXml = (date, rate) => `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope><Cube><Cube time='${date}'><Cube currency='USD' rate='${rate}'/><Cube currency='JPY' rate='174.39'/></Cube></Cube></gesmes:Envelope>`;
const day = (n, d = 0) => new Date((Math.floor(n / 86400) - d) * 86400000).toISOString().slice(0, 10);
await t('ECB XML: today / 5 days old ok; 6 days old, future, implausible, garbage, two dates -> null', () => {
  const n = 1800000000;
  assert.deepEqual(V.parseEcbXml(ecbXml(day(n), '1.0963'), n), { usdPerEur: 1.0963, date: day(n) });
  assert.equal(V.parseEcbXml(ecbXml(day(n, 5), '1.0963'), n).date, day(n, 5));
  assert.equal(V.parseEcbXml(ecbXml(day(n, 6), '1.0963'), n), null);
  assert.equal(V.parseEcbXml(ecbXml(day(n, -1), '1.0963'), n), null);
  for (const r of ['3.5', '0.2', '1,09', '1.0963e0', 'abc']) assert.equal(V.parseEcbXml(ecbXml(day(n), r), n), null);
  assert.equal(V.parseEcbXml('<html>error</html>', n), null); assert.equal(V.parseEcbXml(null, n), null);
  assert.equal(V.parseEcbXml(ecbXml(day(n), '1.0963') + ecbXml(day(n, 1), '1.2'), n), null);
});
await t('rate: CoinGecko down -> EUR = WhatsOnChain USD / ECB, source shown; cached 1 h; backup:false / stale ECB / no WoC -> no rate', async () => {
  const n = 1800000000; let ecbCalls = 0;
  const mk = (cg, woc, xml) => async (url) => { if (url.includes('ecb.europa.eu')) { ecbCalls++; return { ok: true, status: 200, text: async () => xml }; }
    return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('coingecko') ? cg : woc) }; };
  V.clearEcbCache();
  await assert.rejects(V.fetchRate('EUR', { now: n, fetchImpl: mk({}, { rate: 21.926, time: n - 10, currency: 'USD' }, ecbXml(day(n), '1.0963')) }), /single_rate_source/);
  V.clearEcbCache(); ecbCalls = 0;
  const r = await V.fetchRate('EUR', { now: n, minSources: 1, fetchImpl: mk({}, { rate: 21.926, time: n - 10, currency: 'USD' }, ecbXml(day(n), '1.0963')) });
  assert.equal(r.source, 'whatsonchain+ecb'); assert.equal(r.rate, 20); assert.equal(r.ecbRate, 1.0963); assert.equal(r.usdRate, 21.926); assert.equal(r.ecbDate, day(n)); assert.equal(r.rateTime, n - 10);
  await V.fetchRate('EUR', { now: n + 60, minSources: 1, fetchImpl: mk({}, { rate: 21.926, time: n + 50, currency: 'USD' }, 'not used') }); assert.equal(ecbCalls, 1);
  V.clearEcbCache();
  await assert.rejects(V.fetchRate('EUR', { now: n, fetchImpl: mk({}, { rate: 21.926, time: n, currency: 'USD' }, ecbXml(day(n, 6), '1.0963')) }));
  await assert.rejects(V.fetchRate('EUR', { now: n, fetchImpl: mk({}, { rate: 21.926, time: n - 900, currency: 'USD' }, ecbXml(day(n), '1.0963')) }));
  await assert.rejects(V.fetchRate('EUR', { now: n, backup: false, fetchImpl: mk({}, { rate: 21.926, time: n, currency: 'USD' }, ecbXml(day(n), '1.0963')) }));
  await assert.rejects(V.fetchRate('USD', { now: n, backup: false, fetchImpl: mk({}, { rate: 21.926, time: n, currency: 'USD' }, '') }));
  V.clearEcbCache();
});
await t('policy: 20.00 EUR still 0-conf (fallback), 20.01 waits without quick check, 200.00 needs quick check, USD from ECB, BSV from rate', () => {
  assert.equal(V.requiredConfirmations({ cents: 2000 }), 0); assert.equal(V.requiredConfirmations({ cents: 2001 }), 1);
  assert.equal(V.requiredConfirmations({ cents: 20000, quickCheck: QC_OK }), 0);
  assert.equal(V.requiredConfirmations({ cents: 20000, quickCheck: { ok: true } }), 1);   // forged (not from runQuickCheck) -> ignored
  assert.equal(V.requiredConfirmations({ cents: 2500, quickCheck: true }), 1);   // plain true is ignored too
  assert.equal(V.requiredConfirmations({ cents: 20000 }), 1);
  assert.equal(V.requiredConfirmations({ cents: 20001, quickCheck: QC_OK }), 1);
  assert.equal(V.requiredConfirmations({ cents: 4000, zeroConfUpToCents: 5000 }), 1);
  assert.equal(V.requiredConfirmations({ cents: 4000, zeroConfUpToCents: 5000, quickCheck: QC_OK }), 0);
  assert.equal(V.requiredConfirmations({ cents: 1, zeroConfUpToCents: 0 }), 1);
  // USD: 20 EUR * 1.0963 = 21.926 -> 2192 cents floor; 21.92 USD is 0-conf, 21.93 waits without quick check
  assert.equal(V.requiredConfirmations({ cents: 2192, currency: 'USD', usdPerEur: '1.0963' }), 0);
  assert.equal(V.requiredConfirmations({ cents: 2193, currency: 'USD', usdPerEur: '1.0963' }), 1);
  assert.equal(V.requiredConfirmations({ cents: 21926, currency: 'USD', usdPerEur: '1.0963', quickCheck: QC_OK }), 0);
  assert.equal(V.requiredConfirmations({ cents: 1000, currency: 'USD' }), 1); // no ECB rate -> wait
  // BSV: 20 EUR at 20 EUR/BSV = 1 BSV = 1e8 sats; no rate -> wait; explicit confirmFromSats keeps the old rule
  assert.equal(V.requiredConfirmations({ sats: 999999 }), 1);
  assert.equal(V.requiredConfirmations({ sats: 100000000, eurRate: 20 }), 0);
  assert.equal(V.requiredConfirmations({ sats: 100000001, eurRate: 20 }), 1);
  assert.equal(V.requiredConfirmations({ sats: 1000000000, eurRate: 20, quickCheck: QC_OK }), 0); // 10 BSV = 200 EUR
  assert.equal(V.requiredConfirmations({ sats: 1000000001, eurRate: 20, quickCheck: QC_OK }), 1);
  assert.equal(V.requiredConfirmations({ sats: 999999, confirmFromSats: V.CONFIRM_FROM_SATS }), 0);
  assert.equal(V.requiredConfirmations({ sats: 1000000, confirmFromSats: V.CONFIRM_FROM_SATS }), 1);
  assert.equal(V.eurToUsdCents(20000, '1.0963'), 21926);
  assert.equal(V.eurToSatsFloor(2000, 20), 100000000);
  assert.equal(V.feeSufficient(100, 1000, 100), true);
  assert.equal(V.feeSufficient(99, 1000, 100), false);
  assert.equal(V.isTxFinal({ inputs: [{ sequence: 0xffffffff }], locktime: 99 }), true);
  assert.equal(V.isTxFinal({ inputs: [{ sequence: 0xfffffffe }], locktime: 99 }, 10, 50), false);
  for (const o of [{ cents: 0 }, { cents: 1.5 }, { cents: 2000, zeroConfUpToCents: -1 }, { sats: 0 }, {}]) assert.throws(() => V.requiredConfirmations(o));
});
await t('policy in verifyPayment: 0-conf 20 EUR paid, 25 EUR pending until 1 conf unless quick check, bad threshold -> bad_input', async () => {
  const id = put([[150000, SCRIPT]]);
  let r = await verify({ txid: id, exactSats: 150000, orderCents: 2000 }); assert.equal(r.status, 'paid'); assert.equal(r.requiredConfirmations, 0);
  const id2 = put([[190000, SCRIPT]]);
  r = await verify({ txid: id2, exactSats: 190000, orderCents: 2500, minConfirmations: 0 }); assert.equal(r.status, 'pending'); assert.equal(r.requiredConfirmations, 1);
  TX.get(id2).confirmations = 1; TX.get(id2).blocktime = now;
  r = await verify({ txid: id2, exactSats: 190000, orderCents: 2500 }); assert.equal(r.status, 'paid');
  const id3 = put([[190001, SCRIPT]]);
  assert.equal((await verify({ txid: id3, exactSats: 190001, orderCents: 2500, zeroConfUpToCents: 3000 })).status, 'pending'); // above 20 EUR fallback, no quick check
  assert.equal((await verify({ txid: id3, exactSats: 190001, orderCents: 2500, zeroConfUpToCents: 3000, quickCheck: QC_OK })).status, 'paid');
  assert.equal((await verify({ txid: id3, exactSats: 190001, orderCents: 2500, zeroConfUpToCents: 3000, quickCheck: { ok: true } })).status, 'bad_input');   // forged browser value
  assert.equal((await verify({ txid: id3, exactSats: 190001, orderCents: 2500, zeroConfUpToCents: 3000, quickCheck: true })).status, 'bad_input');
  const id4 = put([[2000000, SCRIPT]]);
  assert.equal((await verify({ txid: id4, exactSats: 2000000, eurRate: undefined })).status, 'pending');     // BSV, no rate -> wait
  assert.equal((await verify({ txid: id4, exactSats: 2000000, eurRate: 20 })).status, 'paid'); // 0.02 BSV at 20 EUR/BSV is 0.40 EUR
  assert.equal((await verify({ txid: id4, exactSats: 2000000, orderCents: 'x' })).status, 'bad_input');
  assert.equal((await verify({ txid: id4, exactSats: 2000000, orderCents: 1000, zeroConfUpToCents: 1.5 })).status, 'bad_input');
});
await t('server quick check: trusted result only from runQuickCheck; ok / double-spend / low fee / not final / Broadcaster down', async () => {
  assert.equal(QC_OK.ok, true, JSON.stringify(QC_OK)); assert.equal(V.isTrustedQuickCheck(QC_OK), true);
  assert.equal(V.isTrustedQuickCheck({ ...QC_OK }), false);          // a copy (e.g. JSON from the browser) is not trusted
  assert.throws(() => { QC_OK.ok = false; });                         // frozen
  const parent = put([[300000, OTHER]], { confirmations: 2, blocktime: now - 3600 });
  const mk = (outs, opt) => { const hex = rawTxFrom(parent, outs, opt); const id = txid(hex); TX.set(id, { hex, confirmations: 0, blocktime: 0 }); return id; };
  const ds = mk([[290001, SCRIPT]]); BC.status.set(ds, { txStatus: 'SEEN_ON_NETWORK', competingTxs: ['ab'.repeat(32)] });
  let q = await V.runQuickCheck({ txid: ds, source: { woc: BASE }, broadcasters: BCS, watchMs: 3000, pollMs: 200 });
  assert.equal(q.ok, false); assert.equal(q.reason, 'double_spend'); assert.equal(q.hard, true);
  const low = mk([[299990, SCRIPT]]);     // fee 10 sats for ~200 bytes < 100 sat/kB
  q = await V.runQuickCheck({ txid: low, source: { woc: BASE }, broadcasters: BCS, watchMs: 3000, pollMs: 200 });
  assert.equal(q.reason, 'low_fee'); assert.equal(q.hard, true);
  const nf = mk([[290002, SCRIPT]], { sequence: '00000000', locktime: 'ffffff7f' });
  q = await V.runQuickCheck({ txid: nf, source: { woc: BASE }, broadcasters: BCS, watchMs: 3000, pollMs: 200 });
  assert.equal(q.reason, 'not_final'); assert.equal(q.hard, true);
  BC.down = true; const dn = mk([[290003, SCRIPT]]);
  q = await V.runQuickCheck({ txid: dn, source: { woc: BASE }, broadcasters: BCS, watchMs: 3000, pollMs: 200 });
  assert.equal(q.ok, false); assert.equal(q.reason, 'arc_unavailable'); assert.ok(!q.hard); BC.down = false;
  q = await V.runQuickCheck({ txid: dn, source: { woc: BASE }, broadcasters: ['http://evil.example'], watchMs: 3000 });
  assert.equal(q.reason, 'bad_input');
  q = await V.runQuickCheck({ txid: dn, source: { woc: BASE }, broadcasters: BCS, watchMs: 500 });
  assert.equal(q.reason, 'bad_input');                                 // window cannot be shortened below 3 s
});
await t("verifyPayment quickCheck:'run': 25 EUR paid at 0-conf after a passed server check, pending on double-spend or Broadcaster down, 15 EUR needs no check", async () => {
  const parent = put([[400000, OTHER]], { confirmations: 2, blocktime: now - 3600 });
  const mk = (outs) => { const hex = rawTxFrom(parent, outs); const id = txid(hex); TX.set(id, { hex, confirmations: 0, blocktime: 0 }); return id; };
  const a = mk([[190000, SCRIPT]]);
  let r = await verify({ txid: a, exactSats: 190000, orderCents: 2500, quickCheck: 'run', broadcasters: BCS, quickWatchMs: 3000 });
  assert.equal(r.status, 'paid', JSON.stringify(r)); assert.equal(r.requiredConfirmations, 0); assert.equal(r.quickCheck.ok, true);
  const b = mk([[190001, SCRIPT]]); BC.status.set(b, { txStatus: 'DOUBLE_SPEND_ATTEMPTED', competingTxs: ['cd'.repeat(32)] });
  r = await verify({ txid: b, exactSats: 190001, orderCents: 2500, quickCheck: 'run', broadcasters: BCS, quickWatchMs: 3000 });
  assert.equal(r.status, 'pending'); assert.equal(r.quickCheck.reason, 'double_spend');
  BC.down = true; const c = mk([[190002, SCRIPT]]);
  r = await verify({ txid: c, exactSats: 190002, orderCents: 2500, quickCheck: 'run', broadcasters: BCS, quickWatchMs: 3000 });
  assert.equal(r.status, 'pending'); assert.equal(r.quickCheck.reason, 'arc_unavailable');
  const posts = BC.posts; const d = mk([[190003, SCRIPT]]);
  r = await verify({ txid: d, exactSats: 190003, orderCents: 1500, quickCheck: 'run', broadcasters: BCS, quickWatchMs: 3000 });
  assert.equal(r.status, 'paid'); assert.equal(BC.posts, posts);       // within the 20 EUR fallback: no Broadcaster call needed
  BC.down = false;
  const e = mk([[190004, SCRIPT]]);
  r = await verify({ txid: e, exactSats: 190004, orderCents: 25000, quickCheck: 'run', broadcasters: BCS, quickWatchMs: 3000 });
  assert.equal(r.status, 'pending'); assert.equal(r.quickCheck, undefined);   // above 200 EUR: always 1 confirmation, no check
});
// ---- v1.3.0: exact-amount (exact by default), verify-limits (size before hashing, streaming cap, https-only RPC)
await t('v1.3.0 exact-amount: two buyers pay the same address - exactSats binds each payment to its own order only', async () => {
  const a = put([[50037, SCRIPT]]), b = put([[50052, SCRIPT]]);
  assert.equal((await verify({ txid: a, exactSats: 50037, orderId: 'A' })).status, 'paid');
  assert.equal((await verify({ txid: b, exactSats: 50037, orderId: 'A' })).status, 'overpaid');     // buyer B's tx is not A's payment
  assert.equal((await verify({ txid: b, exactSats: 50052, orderId: 'B' })).status, 'paid');
});
await t('v1.3.0 verify-limits: a raw tx above 1 MB is refused as too_large before any hashing; parseRawTx has the same cap', async () => {
  const big = rawTx([[50037, SCRIPT]], { extra: '00'.repeat(1024 * 1024 + 10) }); const id = 'ef'.repeat(32);
  TX.set(id, { hex: big, confirmations: 0, blocktime: 0 });
  const t0 = Date.now(); const r = await verify({ txid: id, exactSats: 50037 });
  assert.equal(r.status, 'bad_tx'); assert.equal(r.reason, 'too_large'); assert.ok(Date.now() - t0 < 3000);
  assert.throws(() => V.parseRawTx(big), /bad_hex/); assert.equal(V.MAX_TX_BYTES, 1024 * 1024);
});
await t('v1.3.0 verify-limits: readCapped stops an endless body early (stream cancelled), refuses a big Content-Length up front', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(V.readCapped(new Response(body), 1024 * 1024), /too_large/);
  assert.ok(cancelled && pulls < 40, 'pulls=' + pulls);
  await assert.rejects(V.readCapped(new Response('x', { headers: { 'content-length': String(5e7) } }), 1024), /too_large/);
  assert.equal(await V.readCapped(new Response('hello'), 10), 'hello');
  // a source answering a huge hex body is refused, not read into memory
  const f = async (url) => new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('00'.repeat(32768))); } }), { status: 200 });
  const r = await V.verifyPayment({ txid: 'ab'.repeat(32), address: ADDR, exactSats: 1, orderId: 'X', claims: new V.MemoryClaims(), fetchImpl: f });
  assert.equal(r.status, 'bad_tx'); assert.equal(r.reason, 'too_large');
});
await t('v1.3.0 verify-limits: RPC source must be https:// (http only for localhost / 127.0.0.1 / [::1]); custom WoC base likewise', async () => {
  const id = put([[50037, SCRIPT]]);
  for (const url of ['http://node.example.com:8332/', 'ftp://x/', 'http://192.0.2.5:8332', 'http://localhost.evil.com/']) {
    assert.equal((await verify({ txid: id, exactSats: 50037, source: { rpc: { url, user: 'u', password: 'p' } } })).status, 'bad_input', url);
  }
  assert.equal((await verify({ txid: id, exactSats: 50037, source: { woc: 'http://api.example.com/v1/bsv/main' } })).status, 'bad_input');
  assert.equal(V.sourceUrlOk('https://node.example.com/rpc'), true); assert.equal(V.sourceUrlOk('http://[::1]:8332/'), true); assert.equal(V.sourceUrlOk('http://127.0.0.1:8332'), true);
});
srv.close();
const passed = results.filter((x) => x[0] === 'PASS').length, failed = results.length - passed;
console.log(JSON.stringify({ passed, failed }));
