// Node tests for the (not deployed) check worker: mocked WoC + one live read-only check.
import http from 'node:http';
import assert from 'node:assert/strict';
import worker, { addressScript, satsToScript } from '../worker/src/index.js';

const results = []; const ok = (n) => { results.push(['PASS', n]); console.log('PASS', n); };
const ADDR = '1111111111111111111114oLvT2';                    // all-zero hash160 placeholder
const SCRIPT = '76a914' + '00'.repeat(20) + '88ac';
const now = Math.floor(Date.now() / 1000);
const tx = (id, sats, extra) => ({ txid: id, confirmations: 0, vout: [{ value: sats / 1e8, scriptPubKey: { hex: SCRIPT } }, { value: 1, scriptPubKey: { hex: '76a914' + '11'.repeat(20) + '88ac' } }], ...extra });
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
let mode = 'ok';
const TX = { [A]: tx(A, 50037), [B]: tx(B, 50036), [C]: tx(C, 99999, { confirmations: 3, blocktime: now - 86400 }) };
const srv = http.createServer((q, r) => {
  if (mode === '429') { r.writeHead(429); return r.end(); }
  const u = q.url;
  let body = null;
  if (u.includes('/unconfirmed/history')) body = { result: [{ tx_hash: A }, { tx_hash: B }] };
  else if (u.includes('/confirmed/history')) body = { result: [{ tx_hash: C, height: 1 }] };
  else { const m = u.match(/\/tx\/hash\/([0-9a-f]{64})/); if (m && TX[m[1]]) body = TX[m[1]]; }
  if (!body) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(body));
});
await new Promise((res) => srv.listen(0, '127.0.0.1', res));
const env = { WOC_BASE: 'http://127.0.0.1:' + srv.address().port };
const call = async (qs, e = env) => { const r = await worker.fetch(new Request('https://x.test/api/pay/check?' + qs), e, {}); return [r.status, await r.json(), r]; };

assert.equal(await addressScript(ADDR), SCRIPT); ok('worker: placeholder address -> P2PKH script');
assert.equal(await addressScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'); ok('worker: genesis address -> correct hash160');
for (const bad of ['garbage', '1111111111111111111114oLvT3', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', '<script>']) assert.equal(await addressScript(bad), null);
ok('worker: rejects garbage / bad checksum / P2SH / bech32 / html');
let [s, j, r] = await call('to=' + ADDR + '&amount=50037&since=' + now);
assert.equal(s, 200); assert.deepEqual(j.matches.map((m) => m.txid), [A]); ok('worker: exact unique amount matches only tx A (B is 1 sat short, C is too old)');
assert.equal(r.headers.get('access-control-allow-origin'), '*'); assert.equal(r.headers.get('set-cookie'), null); ok('worker: CORS *, no cookies');
[s, j] = await call('to=' + ADDR + '&amount=50000&since=0');
assert.deepEqual(j.matches.map((m) => m.txid).sort(), [A, B, C].sort()); ok('worker: since=0 + lower amount -> all three');
[s, j] = await call('to=garbage&amount=1&since=0'); assert.equal(s, 400); assert.equal(j.error, 'bad_address'); ok('worker: 400 bad_address');
[s, j] = await call('to=' + ADDR + '&amount=0.5&since=0'); assert.equal(s, 400); ok('worker: 400 bad_amount (sats must be integer)');
mode = '429'; [s, j, r] = await call('to=' + ADDR + '&amount=1&since=0'); assert.equal(s, 503); assert.equal(r.headers.get('retry-after'), '10'); ok('worker: WoC 429 -> 503 + Retry-After'); mode = 'ok';
const rl = { limit: async () => ({ success: false }) };
[s, j] = await call('to=' + ADDR + '&amount=1&since=0', { ...env, PAY_RL: rl }); assert.equal(s, 429); ok('worker: rate-limit binding enforced');
srv.close();

// ---- live, read-only check against WhatsOnChain mainnet (no spending, public data only)
const LIVE = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
try {
  const hist = await (await fetch('https://api.whatsonchain.com/v1/bsv/main/address/' + LIVE + '/confirmed/history?order=desc&limit=1')).json();
  const h = hist.result[hist.result.length - 1].tx_hash;
  const t = await (await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/hash/' + h)).json();
  const want = satsToScript(t, await addressScript(LIVE));
  assert.ok(want > 0);
  let [s2, j2] = await call('to=' + LIVE + '&amount=' + want + '&since=0', {});
  if (s2 === 503) { await new Promise((r) => setTimeout(r, 3000)); [s2, j2] = await call('to=' + LIVE + '&amount=' + want + '&since=0', {}); }
  assert.equal(s2, 200); assert.ok(j2.matches.some((m) => m.txid === h && m.sats === want));
  ok('worker LIVE: real mainnet tx ' + h.slice(0, 12) + '… paying ' + want + ' sats to ' + LIVE + ' is detected');
  [s2, j2] = await call('to=' + LIVE + '&amount=' + (want + 1) + '&since=0', {});
  assert.ok(!j2.matches || !j2.matches.some((m) => m.txid === h)); ok('worker LIVE: same tx with amount+1 sat is NOT matched');
} catch (e) { console.log('LIVE check failed:', e.message); results.push(['FAIL', 'worker LIVE']); process.exitCode = 1; }
console.log(JSON.stringify({ passed: results.filter((x) => x[0] === 'PASS').length, failed: results.filter((x) => x[0] === 'FAIL').length }));
