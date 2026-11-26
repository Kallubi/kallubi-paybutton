"""E2E against a REAL local regtest chain (no mocks): SV Node 1.2.3 (regtest, loopback) -> Kallubi indexer prototype
-> explorer-api from the fix pack (PUBLIC_CORS_GET=1, INDEXER_URL) -> Pay Button v1.2.0 in Chromium with data-fallback="0".
The merchant address is the mainnet spelling of a regtest key hash (same locking script), so the widget's mainnet-only
address check stays untouched. Needs a local regtest setup (not part of this repo), given by environment variables:
KALLUBI_E2E_INDEXER (indexer checkout with test/node.sh), KALLUBI_E2E_API (folder with explorer-api.js), KALLUBI_E2E_DATADIR
(regtest node data dir), plus http.server on 8765. Without them the test is skipped. Nothing leaves 127.0.0.1."""
import json, os, subprocess, sys, time, hashlib, signal
from playwright.sync_api import sync_playwright

IDX = os.environ.get('KALLUBI_E2E_INDEXER', '')
FIX = os.environ.get('KALLUBI_E2E_API', '')
DD = os.environ.get('KALLUBI_E2E_DATADIR', '')
NODE_SH = IDX + '/test/node.sh'
if not (IDX and FIX and DD and os.path.isfile(NODE_SH)):
    print('SKIP e2e_regtest: set KALLUBI_E2E_INDEXER, KALLUBI_E2E_API and KALLUBI_E2E_DATADIR to a local regtest setup')
    sys.exit(0)
EAPI_PORT, IDX_PORT = 18795, 18796
BASE = 'http://127.0.0.1:8765'
NODE_URL = 'http://127.0.0.1:%d/v1/bsv/main' % EAPI_PORT
results = []
def check(name, cond, info=''):
    results.append({'test': name, 'ok': bool(cond), 'info': info})
    print(('PASS ' if cond else 'FAIL ') + name + (('  [' + str(info)[:300] + ']') if info != '' else ''), flush=True)
def cli(*a):
    out = subprocess.run([NODE_SH, 'cli', *[str(x) for x in a]], capture_output=True, text=True, check=True).stdout.strip()
    try: return json.loads(out)
    except Exception: return out
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58(b):
    n = int.from_bytes(b, 'big'); s = ''
    while n: n, r = divmod(n, 58); s = B58[r] + s
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + s
def mainnet_alias(h160hex):
    p = b'\0' + bytes.fromhex(h160hex); return b58(p + hashlib.sha256(hashlib.sha256(p).digest()).digest()[:4])
def h160_of(addr): return cli('validateaddress', addr)['scriptPubKey'][6:46]

procs = []
def start(cmd, env):
    p = subprocess.Popen(cmd, env={**os.environ, **env}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); procs.append(p); return p
def stop_all():
    for p in procs:
        try: p.send_signal(signal.SIGTERM); p.wait(5)
        except Exception: p.kill()
cookie = DD + '/regtest/.cookie'
start(['node', IDX + '/bin/kallubi-indexer.js'], {'DB_DIR': '/tmp/kidx-pb-e2e', 'RPC_PORT': '18620', 'RPC_COOKIE_FILE': cookie, 'ZMQ': 'tcp://127.0.0.1:18622',
      'API_PORT': str(IDX_PORT), 'NET': 'regtest', 'POLL_MS': '2000', 'QUIET': '1'})
start(['node', FIX + '/explorer-api.js'], {'RPC_URL': 'http://127.0.0.1:18620', 'RPC_COOKIE_FILE': cookie, 'LISTEN_PORT': str(EAPI_PORT),
      'PUBLIC_CORS_GET': '1', 'INDEXER_URL': 'http://127.0.0.1:%d' % IDX_PORT, 'TRUST_CF_IP': '0', 'RATE_BURST': '100000', 'RATE_PER_SEC': '10000'})
def http_get(u):
    import urllib.request
    try: return json.load(urllib.request.urlopen(u, timeout=5))
    except Exception: return None
for i in range(240):
    st = http_get('http://127.0.0.1:%d/status' % IDX_PORT)
    if st and st['hash'] == cli('getbestblockhash'): break
    time.sleep(0.5)
check('setup: indexer synced, explorer-api up', st and http_get(NODE_URL.replace('/v1/bsv/main', '/v1/health')) == {'ok': True}, st)

def mount(pg, attrs):
    pg.evaluate("""(a) => { const s = document.getElementById('slot'); s.textContent = ''; const d = document.createElement('div');
      d.setAttribute('data-kallubi-pay', ''); d.id = 'w'; const T = {'data-node': 'node', 'data-api': 'api', 'data-quick-ms': 'quickMs', 'data-fallback-url': 'fallbackUrl', 'data-broadcaster-url': 'broadcasterUrl', 'data-shipping-url': 'shippingUrl', 'data-shipping-email': 'shippingEmail'}; const o = Object.assign({}, a.__opts || {}); let use = !!a.__opts; for (const k in a) { if (k === '__opts') continue; if (T[k] && !(k === 'data-node' && a[k] === '')) { o[T[k]] = a[k]; use = true; } else d.setAttribute(k, a[k]); } if ('data-shipping' in a && !('shippingInEvents' in o)) { o.shippingInEvents = true; use = true; } if (use) KallubiPay.mount(d, o); s.appendChild(d); /* v1.3.0: trusted settings via KallubiPay.mount options */ }""", attrs)
    pg.wait_for_function("document.querySelector('#w .kallubi-pay-host')")
def click(pg): pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').click()")
def inv_sats(pg): return round(float(pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('[data-amount]').getAttribute('data-amount')")) * 1e8)
def ev(pg, t): return [e for e in pg.evaluate('window.__ev') if e['type'] == t]
def wait(pg, js, ms):
    try: pg.wait_for_function(js, timeout=ms); return True
    except Exception: return False
def view(pg): return pg.evaluate("(() => { const h = document.querySelector('[data-kallubi-modal]'); const d = h && h.shadowRoot.querySelector('.modal'); return d && d.dataset.view; })()")
btc = lambda s: '%.8f' % (s / 1e8)

try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    def page():
        ctx = b.new_context(); pg = ctx.new_page(); errs = []; ext = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('request', lambda r: (not r.url.startswith('http://127.0.0.1')) and ext.append(r.url))
        pg.goto(BASE + '/tests/blank.html'); pg.wait_for_function('window.KallubiPay'); return ctx, pg, errs, ext
    def widget(pg, amount, regaddr, h160=None, conf=None):
        mount(pg, {'data-to': mainnet_alias(h160 or h160_of(regaddr)), 'data-amount': amount, 'data-poll-ms': '1000', 'data-node': NODE_URL, 'data-fallback': '0', 'data-confirm-above': (conf or '21000000')})
        click(pg); pg.wait_for_timeout(2000); return inv_sats(pg)

    # E1: small amount, 0-conf
    ctx, pg, errs, ext = page(); A = cli('getnewaddress'); s = widget(pg, '0.005', A)
    txid = cli('sendtoaddress', A, btc(s))
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 20000); d = ev(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('regtest 0-conf: real tx detected via own node + indexer, exact sats', ok and d['txid'] == txid and d['sats'] == s and d['confirmations'] == 0, d)
    check('regtest: no request left 127.0.0.1, no JS errors', ext == [] and errs == [], [ext[:3], errs]); ctx.close()

    # E2: >= 0.01 waits for a block
    ctx, pg, errs, ext = page(); A = cli('getnewaddress'); s = widget(pg, '0.02', A, conf='0.01')
    txid = cli('sendtoaddress', A, btc(s))
    okS = wait(pg, "window.__ev.some(e => e.type === 'kallubi:seen')", 20000)
    pg.wait_for_timeout(4000); still = view(pg) == 'confirming' and not ev(pg, 'kallubi:paid')
    cli('generate', 1)
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 30000); d = ev(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('regtest >= 0.01: seen, waits, paid confirmed:true after the block', okS and still and ok and d['confirmed'] is True and d['confirmations'] >= 1 and d['txid'] == txid, d); ctx.close()

    # E3: 1 sat short
    ctx, pg, errs, ext = page(); A = cli('getnewaddress'); s = widget(pg, '0.004', A)
    cli('sendtoaddress', A, btc(s - 1))
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid' || e.type === 'kallubi:seen')", 12000)
    check('regtest: 1 sat short is never accepted', not ok); ctx.close()

    # E4: payment double-spent away after it was seen -> dropped, never paid
    # all keys outside the node wallet, so the wallet cannot re-broadcast X after the restart
    newkey = lambda: json.loads(subprocess.run(['node', '-e', "console.log(JSON.stringify((k => ({address: k.address, wif: k.wif, h160: k.h160.toString('hex')}))(require('%s/test/keys.js').newKey())))" % IDX], capture_output=True, text=True, check=True).stdout)
    key, merchant, change, thief = newkey(), newkey(), newkey(), newkey()
    fund = cli('sendtoaddress', key['address'], '1.0'); cli('generate', 1)
    fvout = [v for v in cli('getrawtransaction', fund, 1)['vout'] if v['scriptPubKey']['hex'] == '76a914' + key['h160'] + '88ac'][0]['n']
    ctx, pg, errs, ext = page(); A = merchant['address']; s = widget(pg, '0.03', None, merchant['h160'], conf='0.01')
    other = change['address']
    def mk(to, sats):
        raw = cli('createrawtransaction', json.dumps([{'txid': fund, 'vout': fvout}]), json.dumps({to: btc(sats), other: btc(100000000 - sats - 10000)}))
        r = cli('signrawtransaction', raw, json.dumps([{'txid': fund, 'vout': fvout, 'scriptPubKey': '76a914' + key['h160'] + '88ac', 'amount': 1.0}]), json.dumps([key['wif']]))
        return r['hex']
    X = mk(A, s); Y = mk(thief['address'], s)
    xid = cli('sendrawtransaction', X)
    okS = wait(pg, "window.__ev.some(e => e.type === 'kallubi:seen')", 20000)
    subprocess.run([NODE_SH, 'stop'], check=True); subprocess.run([NODE_SH, 'start'], check=True)   # persistmempool=0: X is gone
    cli('sendrawtransaction', Y); cli('generate', 1)
    t0 = time.time(); okD = wait(pg, "window.__ev.some(e => e.type === 'kallubi:dropped')", 200000)
    check('regtest double spend after "seen": kallubi:dropped after %ds, never paid' % round(time.time() - t0), okS and okD and not ev(pg, 'kallubi:paid') and view(pg) == 'dropped', [okS, okD, view(pg)])
    check('regtest drop scenario: no JS errors', errs == [], errs); ctx.close()
    b.close()
finally:
    stop_all()
    subprocess.run(['rm', '-rf', '/tmp/kidx-pb-e2e'])
passed = sum(r['ok'] for r in results)
json.dump(results, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results-e2e-regtest.json'), 'w'), indent=1)
print(json.dumps({'passed': passed, 'failed': len(results) - passed}))
sys.exit(0 if passed == len(results) else 1)
