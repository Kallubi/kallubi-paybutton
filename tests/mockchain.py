"""Shared offline chain mock for the Playwright tests (v1.2.0).
Serves BOTH sources the widget reads: Kallubi's own node API and the public fallback API, with REAL raw transactions
(the widget hashes and parses the hex itself, so the mock must build valid txs whose txid = sha256d(hex)).
phase: empty | mempool | confirmed | confirmed_first     node: 'noindex' (default: node has no address index yet ->
address lists via the fallback, txs via the node) | 'index' (everything via the node) | 'down' (node unreachable)."""
import hashlib, json, struct, time

NODE = 'https://node.kallubi-bsv-explorer.de/v1/bsv/main'
FALLBACK = 'https://api.whatsonchain.com/v1/bsv/main'
NODE_GLOB = 'https://node.kallubi-bsv-explorer.de/**'
FALLBACK_GLOB = 'https://api.whatsonchain.com/**'

def varint(n):
    if n < 0xfd: return bytes([n])
    if n <= 0xffff: return b'\xfd' + struct.pack('<H', n)
    return b'\xfe' + struct.pack('<I', n)

PARENTS = {}  # parent txid (hex) -> raw hex, so the button can compute the fee

def _txid(raw):
    return hashlib.sha256(hashlib.sha256(raw).digest()).digest()[::-1].hex()

def build_tx(outputs, salt=b'kallubi-test', fee=400, seq=0xffffffff, locktime=0):
    """outputs: [(sats, script_hex)] -> (txid, hex). One real parent output so the fee can be verified."""
    total = sum(s for s, _ in outputs) + fee
    pscript = bytes.fromhex('76a914' + '11' * 20 + '88ac')
    dummy = hashlib.sha256(b'p-' + salt).digest()
    praw = struct.pack('<I', 1) + varint(1) + dummy + struct.pack('<I', 0) + varint(1) + b'\x51' + struct.pack('<I', 0xffffffff)
    praw += varint(1) + struct.pack('<Q', total) + varint(len(pscript)) + pscript + struct.pack('<I', 0)
    ptx = _txid(praw); PARENTS[ptx] = praw.hex()
    raw = struct.pack('<I', 1) + varint(1) + bytes.fromhex(ptx)[::-1] + struct.pack('<I', 0) + varint(1) + b'\x51' + struct.pack('<I', seq)
    raw += varint(len(outputs))
    for sats, script in outputs:
        s = bytes.fromhex(script); raw += struct.pack('<Q', sats) + varint(len(s)) + s
    raw += struct.pack('<I', locktime)
    return _txid(raw), raw.hex()

def is_chain(url): return url.startswith(NODE.split('/v1')[0]) or url.startswith(FALLBACK.split('/v1')[0])

CG = 'https://api.coingecko.com'
ECB = 'https://data-api.ecb.europa.eu'
BROADCASTERS = [
    'https://arcade-eu-1.bsvblockchain.tech',
    'https://arcade-us-1.bsvblockchain.tech',
    'https://arcade.gorillapool.io',
]
CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'}

def stub_rates(target, eur=20.0, usd=22.0, usd_per_eur='1.1000'):
    """Deterministic CoinGecko + ECB + default-down BSV Broadcaster (no live network)."""
    def cg(route):
        now = int(time.time())
        route.fulfill(status=200, body=json.dumps({'bitcoin-cash-sv': {'eur': eur, 'usd': usd, 'last_updated_at': now - 10}}),
                      headers={**CORS, 'Content-Type': 'application/json'})
    def ecb(route):
        day = time.strftime('%Y-%m-%d', time.gmtime())
        head = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE_COMPL,UNIT'
        row = 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,%s,%s,A,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD' % (day, usd_per_eur)
        route.fulfill(status=200, body=head + '\n' + row + '\n', headers={**CORS, 'Content-Type': 'text/csv'})
    def arc(route):
        if route.request.method == 'OPTIONS':
            return route.fulfill(status=204, headers=CORS)
        if route.request.url.rstrip('/').endswith('/policy'):
            return route.fulfill(status=200, body=json.dumps({'policy': {'miningFee': {'satoshis': 100, 'bytes': 1000}}}),
                                 headers={**CORS, 'Content-Type': 'application/json'})
        route.fulfill(status=404, body='{"error":"transaction not found"}', headers={**CORS, 'Content-Type': 'application/json'})
    target.route(CG + '/**', cg)
    target.route(ECB + '/**', ecb)
    for b in BROADCASTERS:
        target.route(b + '/**', arc)


class MockChain:
    def __init__(self, script, node='noindex', confirmed_list=True):
        self.script = script; self.node = node; self.confirmed_list = confirmed_list
        self.phase = 'empty'; self.calls = []; self.node_calls = []; self.fb_calls = []
        self._sats = 0; self.txid = None; self.hex = None
        self.seq = 0xffffffff; self.locktime = 0   # set before pay_sats: non-final txs (nLockTime + nSequence < 0xffffffff)
        self.tamper = None      # None | 'hex' (node serves wrong bytes) | 'json' (fallback JSON lies about the amount) | 'both'
        self.fb = 'ok'          # ok | down | 500
        self.node_conf = None   # override the node's confirmations (e.g. -1 = orphaned block)
        self.big = False        # node announces a huge hex body
        self.node_txindex = True  # False: node answers 404 for confirmed txs (like a node without -txindex)
        self.status_mode = None   # v1.3.0 status fail-closed: None | '429' | '503' | 'html' (status endpoints /tx/<id>, /tx/hash/<id> fail)
        self.blocktime = None     # override block time of a confirmed tx (e.g. an old tx mined before the invoice)
        self.woc_usd = 22.0       # v1.3.0 second rate source; 22 USD / 1.1 USD per EUR = 20 EUR, agrees with the CoinGecko stub
    @property
    def pay_sats(self): return self._sats
    @pay_sats.setter
    def pay_sats(self, v):
        self._sats = v; self.txid, self.hex = build_tx([(v, self.script), (0, '006a0474657374')], salt=str(v).encode(), seq=self.seq, locktime=self.locktime)
    def set_tx(self, outputs, salt=b'custom'):
        self.txid, self.hex = build_tx(outputs, salt=salt)
    def conf(self): return 0 if self.phase == 'mempool' else (3 if self.phase == 'confirmed_first' else 1)
    def _json(self, route, body, status=200):
        route.fulfill(status=status, body=json.dumps(body), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
    def _text(self, route, body):
        route.fulfill(status=200, body=body, headers={'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*'})
    def _404(self, route, body='{"error":"not found"}'):
        route.fulfill(status=404, body=body, headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
    def handle(self, route):
        u = route.request.url
        # v1.3.0: the second rate source (WhatsOnChain USD, cross-checked against CoinGecko). Answered independently of the
        # chain-fallback state (self.fb), so 'fallback down' tests keep testing chain detection only.
        if u == FALLBACK + '/exchangerate':
            return self._json(route, {'currency': 'USD', 'rate': self.woc_usd, 'time': int(time.time()) - 5})
        if u.startswith(NODE): return self.handle_node(route, u[len(NODE):])
        if u.startswith(FALLBACK): return self.handle_fb(route, u[len(FALLBACK):])
        return self._404(route)
    def known(self): return self.phase != 'empty' and self.txid is not None
    def _status_fail(self, route):
        if self.status_mode == 'html': return route.fulfill(status=200, body='<html><body>429 Too Many Requests</body></html>', headers={'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*'})
        return route.fulfill(status=int(self.status_mode), body='<html>busy</html>', headers={'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*'})
    def _bt(self): return self.blocktime if self.blocktime is not None else int(time.time())
    def handle_node(self, route, p):
        self.calls.append(p); self.node_calls.append(p)
        if self.node == 'down': return route.abort('connectionrefused')
        if self.status_mode and self.known() and p == '/tx/' + self.txid: return self._status_fail(route)
        if p.startswith('/address/'):
            if self.node != 'index': return self._404(route, '{"error":"not available"}')
            unc = [{'tx_hash': self.txid, 'height': 0, 'received': self._sats, 'spent': 0}] if self.known() and self.phase == 'mempool' else []
            con = [{'tx_hash': self.txid, 'height': 900000, 'received': self._sats, 'spent': 0}] if self.known() and self.phase != 'mempool' and self.confirmed_list else []
            return self._json(route, {'unconfirmed': unc, 'confirmed': con, 'next': None})
        if p == '/chain/info': return self._json(route, {'chain': 'main', 'blocks': 900000})
        if not self.node_txindex and self.phase != 'mempool' and p.startswith('/tx/'): return self._404(route)
        if self.known() and p == '/tx/' + self.txid + '/hex':
            if self.big: return route.fulfill(status=200, body='00' * 16, headers={'Content-Type': 'text/plain', 'Content-Length': str(64 * 1024 * 1024), 'Access-Control-Allow-Origin': '*'})
            if self.tamper in ('hex', 'both'): return self._text(route, build_tx([(self._sats * 10, self.script)])[1])
            return self._text(route, self.hex)
        if self.known() and p == '/tx/' + self.txid:
            n = self.conf() if self.node_conf is None else self.node_conf; body = {'txid': self.txid, 'confirmations': n, 'vout': []}
            if n < 0: body['orphaned'] = True
            if n: body.update({'blockhash': '00' * 32, 'blocktime': self._bt(), 'time': self._bt(), 'blockheight': 900000})
            return self._json(route, body)
        for pt, ph in PARENTS.items():
            if p == '/tx/' + pt + '/hex': return self._text(route, ph)
        return self._404(route)
    def handle_fb(self, route, p):
        self.calls.append(p); self.fb_calls.append(p)
        if self.fb == 'down': return route.abort('connectionrefused')
        if self.fb == '500': return route.fulfill(status=500, body='{}', headers={'Access-Control-Allow-Origin': '*'})
        if '/unconfirmed/history' in p: return self._json(route, {'result': [{'tx_hash': self.txid}] if self.known() and self.phase == 'mempool' else []})
        if '/confirmed/history' in p: return self._json(route, {'result': [{'tx_hash': self.txid, 'height': 900000}] if self.known() and self.phase != 'mempool' and self.confirmed_list else []})
        if self.known() and p == '/tx/' + self.txid + '/hex':
            if self.tamper == 'both': return self._text(route, build_tx([(self._sats * 10, self.script)])[1])
            return self._text(route, self.hex)
        if self.known() and p == '/tx/hash/' + self.txid:
            if self.status_mode: return self._status_fail(route)
            n = self.conf(); body = {'txid': self.txid, 'hash': self.txid, 'time': self._bt() if n else int(time.time()), 'confirmations': n,
                                     'vout': [{'value': (self._sats * (100 if self.tamper == 'json' else 1)) / 1e8, 'n': 0, 'scriptPubKey': {'hex': self.script}}]}
            if n: body['blocktime'] = self._bt()
            return self._json(route, body)
        for pt, ph in PARENTS.items():
            if p == '/tx/' + pt + '/hex': return self._text(route, ph)
        return self._404(route)
    def route_all(self, target):
        target.route(NODE_GLOB, self.handle); target.route(FALLBACK_GLOB, self.handle)
        stub_rates(target)


class MockBroadcaster:
    """Public BSV Broadcaster stand-in. mode: ok | down | doublespend | pending."""
    def __init__(self, mode='ok'):
        self.mode = mode; self.posted = {}; self.calls = []
    def handle(self, route):
        u = route.request.url; self.calls.append((route.request.method, u))
        if route.request.method == 'OPTIONS':
            return route.fulfill(status=204, headers=CORS)
        if self.mode == 'down':
            return route.abort('connectionrefused')
        if u.rstrip('/').endswith('/policy') or u.rstrip('/').endswith('/health'):
            body = {'healthy': True, 'policy': {'miningFee': {'satoshis': 100, 'bytes': 1000}}} if u.endswith('/policy') else {'healthy': True}
            return route.fulfill(status=200, body=json.dumps(body), headers={**CORS, 'Content-Type': 'application/json'})
        if route.request.method == 'POST' and u.rstrip('/').endswith('/tx'):
            if self.mode == 'down':
                return route.fulfill(status=503, body='{"error":"down"}', headers={**CORS, 'Content-Type': 'application/json'})
            body = route.request.post_data or ''
            # txid is of the raw (non-EF) payment; the button also posts EF first. Accept both.
            # We just remember the request and answer with a placeholder; GET uses the query path.
            self.posted['last'] = body
            st = 'DOUBLE_SPEND_ATTEMPTED' if self.mode == 'doublespend' else ('RECEIVED' if self.mode == 'pending' else 'SEEN_ON_NETWORK')
            return route.fulfill(status=202, body=json.dumps({'txid': 'pending', 'txStatus': st, 'competingTxs': ['ab'*32] if self.mode == 'doublespend' else []}),
                                 headers={**CORS, 'Content-Type': 'application/json'})
        if '/tx/' in u and route.request.method == 'GET':
            if self.mode == 'down':
                return route.fulfill(status=404, body='{"error":"transaction not found"}', headers={**CORS, 'Content-Type': 'application/json'})
            st = 'DOUBLE_SPEND_ATTEMPTED' if self.mode == 'doublespend' else ('ACCEPTED_BY_NETWORK' if self.mode == 'pending' else 'SEEN_ON_NETWORK')
            body = {'txid': u.rsplit('/', 1)[-1], 'txStatus': st}
            if self.mode == 'doublespend': body['competingTxs'] = ['ab' * 32]
            return route.fulfill(status=200, body=json.dumps(body), headers={**CORS, 'Content-Type': 'application/json'})
        return route.fulfill(status=404, body='{"error":"transaction not found"}', headers={**CORS, 'Content-Type': 'application/json'})
    def route(self, target):
        for b in BROADCASTERS:
            target.route(b + '/**', self.handle)
