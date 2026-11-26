"""Regression tests for v1.3.0 (v1.3.0 hardening). Offline: chain, rates and worker are mocked
with Playwright route() (tests/mockchain.py). One section per finding:
exact-amount exact amount (two buyers, overpaid, worker path), trusted-config payee allowlist / trusted config / mount scope / callbacks,
baseline no match without baseline, tx-limits 1 MB cap + async hashing, rate-check two agreeing rate sources, smaller notes
(shipping address not in bubbling events, DOM clobbering, closed shadow root, frozen API).
Run:  python3 -m http.server 8765 --bind 127.0.0.1 &   then   python tests/test_v130.py"""
import json, time, sys, os, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from mockchain import MockChain, build_tx

BASE = 'http://127.0.0.1:8765'
ADDR = '1111111111111111111114oLvT2'
OTHER = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
SCRIPT = '76a914' + '00' * 20 + '88ac'
results = []
def check(name, cond, info=''):
    results.append({'test': name, 'ok': bool(cond), 'info': info})
    print(('PASS ' if cond else 'FAIL ') + name + (('  [' + str(info)[:400] + ']') if info != '' else ''), flush=True)

MOUNT = """([a, o, id]) => { const s = document.getElementById('slot'); s.textContent = ''; const d = document.createElement('div');
  d.setAttribute('data-kallubi-pay', ''); d.id = id || 'w'; for (const k in a) d.setAttribute(k, a[k]); if (o) KallubiPay.mount(d, o); s.appendChild(d); window.__ev = []; }"""
def mount(pg, attrs, opts=None, wid='w', wait_host=True):
    pg.evaluate(MOUNT, [attrs, opts, wid])
    if wait_host: pg.wait_for_function("(id) => document.querySelector('#' + id + ' .kallubi-pay-host')", arg=wid)
def host_text(pg, wid='w'):
    return pg.evaluate("(id) => { const h = document.querySelector('#' + id + ' .kallubi-pay-host'); return h ? (h.shadowRoot ? h.shadowRoot.textContent : '(closed)') : null; }", wid)
def click(pg, wid='w'): pg.evaluate("(id) => document.querySelector('#' + id + ' .kallubi-pay-host').shadowRoot.querySelector('button').click()", wid)
def view(pg): return pg.evaluate("(() => { const h = document.querySelector('[data-kallubi-modal]'); const d = h && h.shadowRoot && h.shadowRoot.querySelector('.modal'); return d && d.getAttribute('data-view'); })()")
def mq(pg, js): return pg.evaluate("(f) => { const h = document.querySelector('[data-kallubi-modal]'); if (!h || !h.shadowRoot) return null; return (new Function('r', f))(h.shadowRoot); }", js)
def inv_sats(pg): return round(float(mq(pg, "return r.querySelector('[data-amount]').getAttribute('data-amount');")) * 1e8)
def events(pg, t=None): return [e for e in pg.evaluate('window.__ev') if t is None or e['type'] == t]
def wait(pg, js, ms):
    try: pg.wait_for_function(js, timeout=ms); return True
    except Exception: return False
EV = lambda t: "window.__ev.some(e => e.type === '%s')" % t

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    def page(path='/tests/v130.html', chain=None, ready='window.KallubiPay'):
        ctx = b.new_context(viewport={'width': 1100, 'height': 900}); woc = chain or MockChain(SCRIPT)
        woc.route_all(ctx); ext = []
        ctx.on('request', lambda r: ext.append(r.url))
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + path); pg.wait_for_function(ready)
        return ctx, pg, woc, errs, ext

    # ======================================================================= exact-amount: exact amount only
    # Two buyers, same address. Buyer B's payment (a bit more than A's invoice) arrives while A's dialog is open.
    ctx, pg, woc, errs, ext = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000'}); click(pg); pg.wait_for_timeout(1500)
    a_sats = inv_sats(pg)
    woc.pay_sats = a_sats + 37; woc.phase = 'mempool'            # buyer B's invoice: same price, other payment ID
    ok = wait(pg, EV('kallubi:overpaid'), 15000); pg.wait_for_timeout(300)
    note = mq(pg, "const n = r.querySelector('[data-overpaid]'); return n && n.textContent;")
    ov = events(pg, 'kallubi:overpaid'); d = ov[0]['d'] if ov else {}
    check('exact-amount two buyers: B pays more than A\'s invoice -> A is NOT paid, view stays "waiting"', ok and not events(pg, 'kallubi:paid') and view(pg) == 'waiting', [view(pg), [e['type'] for e in events(pg)]])
    check('exact-amount overpaid: kallubi:overpaid with txid, sats, requestedSats (shop can review)', d.get('txid') == woc.txid and d.get('sats') == a_sats + 37 and d.get('requestedSats') == a_sats and d.get('overpaid') is True, d)
    check('exact-amount overpaid: buyer sees a "contact the shop" note with the amount and tx', note and 'contact the shop' in note and '0.0005' in note, note)
    woc.pay_sats = a_sats; woc.phase = 'mempool'                 # now A's own exact payment
    ok = wait(pg, EV('kallubi:paid'), 15000)
    p = events(pg, 'kallubi:paid'); d = p[0]['d'] if p else {}
    check('exact-amount exact: A\'s exact payment is then detected -> paid with exactly the invoice amount', ok and d.get('sats') == a_sats == d.get('requestedSats') and d.get('txid') == woc.txid, d)
    check('exact-amount: no JS errors', not errs, errs)
    ctx.close()

    # opt-in: acceptOverpay (trusted JS config only) restores ">= amount"; the same attribute in markup does nothing
    ctx, pg, woc, errs, ext = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000', 'data-accept-overpay': '1', 'data-acceptoverpay': '1'}); click(pg); pg.wait_for_timeout(1500)
    s = inv_sats(pg); woc.pay_sats = s + 500; woc.phase = 'mempool'
    check('exact-amount opt-in: overpay attributes in markup are ignored (still overpaid, not paid)', wait(pg, EV('kallubi:overpaid'), 15000) and not events(pg, 'kallubi:paid'))
    ctx.close()
    ctx, pg, woc, errs, ext = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000'}, {'acceptOverpay': True}); click(pg); pg.wait_for_timeout(1500)
    s = inv_sats(pg); woc.pay_sats = s + 500; woc.phase = 'mempool'
    ok = wait(pg, EV('kallubi:paid'), 15000); p = events(pg, 'kallubi:paid')
    check('exact-amount opt-in: KallubiPay.mount(el, {acceptOverpay: true}) accepts more than the invoice (pre-1.3 rule)', ok and p and p[0]['d']['sats'] == s + 500 and not events(pg, 'kallubi:overpaid'), p[:1])
    ctx.close()

    # worker path (data-api via trusted config): worker lists the larger tx (overpaid) -> raw tx re-checked -> never paid
    ctx, pg, woc, errs, ext = page()
    api_calls = []
    def api(route):
        api_calls.append(route.request.url)
        ms = [{'txid': woc.txid, 'sats': woc.pay_sats, 'confirmations': 0, 'exact': False, 'overpaid': True}] if woc.known() else []
        route.fulfill(status=200, body=json.dumps({'ok': True, 'matches': ms}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
    ctx.route('https://check.example-shop.test/**', api)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000'}, {'api': 'https://check.example-shop.test/api/pay/check'}); click(pg); pg.wait_for_timeout(1500)
    s = inv_sats(pg); woc.pay_sats = s + 20; woc.phase = 'mempool'
    ok = wait(pg, EV('kallubi:overpaid'), 15000)
    check('exact-amount worker path: client asks the worker with match=exact; larger tx -> overpaid, never paid', ok and not events(pg, 'kallubi:paid') and api_calls and all('match=exact' in u for u in api_calls), api_calls[:1])
    ctx.close()

    # ======================================================================= trusted-config: payee allowlist + trusted config
    ctx, pg, woc, errs, ext = page('/tests/v130-allow.html', ready="document.querySelector('#good .kallubi-pay-host') && document.querySelector('#evil .kallubi-pay-host')")
    ev_txt = host_text(pg, 'evil'); good = host_text(pg, 'good')
    check('trusted-config injected button: data-to not in data-allowed-to -> error box, no pay button', ev_txt and 'allowed list' in ev_txt and pg.evaluate("!document.querySelector('#evil .kallubi-pay-host').shadowRoot.querySelector('button')"), ev_txt)
    check('trusted-config allowlist: the shop\'s own button (allowed address) works normally', good and 'Pay with BSV' in good, good)
    pg.evaluate("KallubiPay.config({allowedTo: ['%s', '%s']})" % (ADDR, OTHER))
    eff = pg.evaluate("KallubiPay.config().allowedTo")
    check('trusted-config allowlist cannot be widened later by KallubiPay.config (only narrowed)', eff == [ADDR], eff)
    mount(pg, {'data-to': OTHER, 'data-amount': '0.0005'})
    check('trusted-config dynamically injected button with a foreign address is refused too', 'allowed list' in (host_text(pg) or ''), host_text(pg))
    # markup overrides are ignored: data-node / data-fallback-url / data-broadcaster-url / data-shipping-url / data-on-paid
    pg.evaluate("() => { window.__hijack = 0; window.evilPaid = function(){ window.__hijack = 1; }; }")
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '800', 'data-shipping': '1', 'data-on-paid': 'evilPaid',
               'data-node': 'https://evil.example/node', 'data-fallback-url': 'https://evil.example/fb', 'data-broadcaster-url': 'https://evil.example/arc',
               'data-shipping-url': 'https://evil.example/steal', 'data-shipping-email': 'thief@evil.example', 'data-quick-ms': '3000'})
    click(pg); wait(pg, "(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view === 'shipping'; })()", 5000)
    priv = mq(pg, "return r.querySelector('.priv').textContent;")
    mq(pg, """const v = {name: 'Erika Example', street: 'Teststr. 1', postalCode: '12345', city: 'Teststadt', country: 'DE', email: 'erika@example.test'};
      for (const k in v) { const i = r.querySelector('[name=' + k + ']'); i.value = v[k]; i.dispatchEvent(new Event('input')); } r.querySelector('form.sf button[type=submit]').click(); return 1;""")
    wait(pg, EV('kallubi:paid'), 8000); pg.wait_for_timeout(400)
    mail = mq(pg, "const a = r.querySelector('[data-mailto]'); return a && a.getAttribute('href');")
    check('trusted-config markup data-shipping-url/-email ignored: address never goes to the injected destination', 'evil.example' not in (priv or '') and (mail or '').startswith('mailto:orders@example-shop.test') and not any('evil.example' in u for u in ext), [priv, (mail or '')[:60]])
    check('trusted-config markup data-node / data-fallback-url / data-broadcaster-url ignored (no request to the injected hosts)', not any('evil.example' in u for u in ext), [u for u in ext if 'evil' in u])
    check('trusted-config data-on-paid in markup is ignored (no global function lookup)', pg.evaluate('window.__hijack') == 0)
    check('trusted-config script-tag data-shipping-email (trusted) is used for the e-mail draft', (mail or '').startswith('mailto:orders@example-shop.test'), (mail or '')[:60])
    ctx.close()

    # KallubiPay.onPaid(fn) + window.KallubiPayConfig (set before the script, plain object)
    ctx, pg, woc, errs, ext = page('/tests/v130-preconfig.html')
    pg.evaluate("() => { window.__cb2 = []; window.__un = KallubiPay.onPaid(function (d) { window.__cb2.push(d); }); }")
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '600'}); click(pg)
    wait(pg, EV('kallubi:paid'), 6000); pg.wait_for_timeout(200)
    cb = pg.evaluate('window.__cb'); cb2 = pg.evaluate('window.__cb2')
    check('trusted-config callbacks: KallubiPayConfig.onPaid and KallubiPay.onPaid(fn) both called once with the paid detail + element',
          len(cb) == 1 and cb[0]['id'] == 'w' and cb[0]['d']['to'] == ADDR and len(cb2) == 1 and cb2[0]['txid'] == cb[0]['d']['txid'], [cb, cb2])
    mount(pg, {'data-to': OTHER, 'data-amount': '0.0005'})
    check('trusted-config KallubiPayConfig.allowedTo applies (foreign address refused)', 'allowed list' in (host_text(pg) or ''))
    pg.evaluate('() => { window.__un(); }'); mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '600'}); click(pg)
    wait(pg, EV('kallubi:paid'), 6000); pg.wait_for_timeout(200)
    check('trusted-config onPaid returns an unsubscribe function', len(pg.evaluate('window.__cb2')) == 1 and len(pg.evaluate('window.__cb')) == 2)
    ctx.close()

    # mount scope + auto-mount off
    ctx, pg, woc, errs, ext = page('/tests/v130-scope.html', ready="document.querySelector('#in .kallubi-pay-host')")
    pg.wait_for_timeout(500)
    pg.evaluate("""() => { const d = document.createElement('div'); d.id = 'late'; d.setAttribute('data-kallubi-pay', ''); d.setAttribute('data-to', '%s');
      d.setAttribute('data-amount', '0.00000001'); document.getElementById('reviews').appendChild(d); }""" % ADDR)
    pg.wait_for_timeout(500)
    st = pg.evaluate("['in', 'out', 'late'].map(id => !!document.querySelector('#' + id + ' .kallubi-pay-host'))")
    check('trusted-config data-mount="#shop": button inside the shop container mounts; buttons in reviews (static or added later) stay inert', st == [True, False, False], st)
    pg.evaluate("KallubiPay.mount(document.getElementById('out'))")
    check('trusted-config explicit KallubiPay.mount() from shop JS still works outside the scope', pg.evaluate("!!document.querySelector('#out .kallubi-pay-host')"))
    ctx.close()
    ctx, pg, woc, errs, ext = page('/tests/v130-noauto.html')
    pg.wait_for_timeout(600)
    before = pg.evaluate("!!document.querySelector('#w .kallubi-pay-host')")
    pg.evaluate("KallubiPay.mount(document.getElementById('w'))")
    check('trusted-config data-auto-mount="0": nothing mounts by itself, KallubiPay.mount(el) mounts', before is False and pg.evaluate("!!document.querySelector('#w .kallubi-pay-host')"), before)
    ctx.close()

    # ======================================================================= baseline: never match without a baseline
    chain = MockChain(SCRIPT, node='down'); chain.fb = 'down'
    chain.pay_sats = 50000; chain.phase = 'confirmed'            # an OLD payment of exactly the same amount is already on chain
    ctx, pg, woc, errs, ext = page(chain=chain)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-unique': '0', 'data-poll-ms': '1000'}); click(pg)
    ok = wait(pg, "(() => { const h = document.querySelector('[data-kallubi-modal]'); return !!(h && h.shadowRoot.querySelector('[data-nocheck]')); })()", 25000)
    txt = mq(pg, "const n = r.querySelector('[data-nocheck]'); return n && n.textContent;")
    check('baseline sources down: after 3 failed baseline reads the dialog says "cannot check right now"', ok and 'Cannot check' in (txt or ''), txt)
    woc.node = 'index'; woc.fb = 'ok'                           # sources come back: the old tx must NOT be taken as this payment
    gone = wait(pg, "(() => { const h = document.querySelector('[data-kallubi-modal]'); return !!(h && h.shadowRoot.querySelector('.w2') && !h.shadowRoot.querySelector('[data-nocheck]')); })()", 40000)
    pg.wait_for_timeout(6000)
    check('baseline empty baseline: an old tx with the same amount is never matched (no paid), status line recovers', gone and not events(pg, 'kallubi:paid') and view(pg) == 'waiting', [gone, view(pg), [e['type'] for e in events(pg)]])
    ctx.close()
    chain = MockChain(SCRIPT, node='down'); chain.fb = 'down'
    ctx, pg, woc, errs, ext = page(chain=chain)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000'}); click(pg); pg.wait_for_timeout(1200)
    s = inv_sats(pg); woc.pay_sats = s; woc.phase = 'mempool'    # buyer pays during the outage
    wait(pg, "(() => { const h = document.querySelector('[data-kallubi-modal]'); return !!(h && h.shadowRoot.querySelector('[data-nocheck]')); })()", 25000)
    woc.node = 'index'; woc.fb = 'ok'
    ok = wait(pg, EV('kallubi:paid'), 45000)
    check('baseline late baseline: a mempool payment made during the outage is still detected (exact amount)', ok and events(pg, 'kallubi:paid')[0]['d']['sats'] == s, [e['type'] for e in events(pg)])
    ctx.close()

    # ======================================================================= tx-limits: 1 MB cap, async hashing, pre-skip
    ctx, pg, woc, errs, ext = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-unique': '0', 'data-poll-ms': '1000'}); click(pg); pg.wait_for_timeout(1500)
    n = 1100 * 1024
    big_script = '006a4e' + struct.pack('<I', n).hex() + '00' * n
    woc.txid, woc.hex = build_tx([(50000, SCRIPT), (0, big_script)], salt=b'giant'); woc._sats = 50000; woc.phase = 'mempool'
    t0 = time.time(); pg.wait_for_timeout(7000)
    lag = pg.evaluate("() => new Promise(res => { const t = performance.now(); setTimeout(() => res(performance.now() - t), 0); })")
    check('tx-limits giant tx (> 1 MB) paying the exact amount is refused (never paid), page stays responsive', not events(pg, 'kallubi:paid') and lag < 200 and not errs, [lag, errs])
    ctx.close()
    ctx, pg, woc, errs, ext = page()
    small_id, small_hex = build_tx([(1000, SCRIPT)], salt=b'small')
    r = pg.evaluate("""([hex, id, s]) => Promise.all([KallubiPay.util.verifiedSatsAsync(hex, 'ff'.repeat(32), s, 50000), KallubiPay.util.verifiedSatsAsync(hex, id, s, 1000),
       KallubiPay.util.verifiedSatsAsync(hex, 'ff'.repeat(32), s, 1000), KallubiPay.util.maxTxHex])""", [small_hex, small_id, SCRIPT])
    check('tx-limits pre-skip: a tx paying less than the invoice is skipped before hashing; verified txs need hash = txid; cap = 1 MB raw',
          r[0] == {'sats': 1000, 'skipped': True} and r[1] == {'sats': 1000} and r[2] is None and r[3] == 2 * 1024 * 1024, r)
    ctx.close()

    # ======================================================================= rate-check: two rate sources must agree
    chain = MockChain(SCRIPT); chain.woc_usd = 30.0                # WoC 30 USD / ECB 1.1 = 27.27 EUR vs. CoinGecko 20 EUR (36 % apart)
    ctx, pg, woc, errs, ext = page(chain=chain)
    mount(pg, {'data-to': ADDR, 'data-amount-fiat': '25', 'data-currency': 'EUR'}); click(pg)
    ok = wait(pg, "(() => { const h = document.querySelector('[data-kallubi-modal]'); const d = h && h.shadowRoot.querySelector('.modal'); return d && d.dataset.view === 'rate'; })()", 15000)
    check('rate-check wrong rate: sources 36 % apart -> no price offer, no QR (rate view)', ok and mq(pg, "return r.querySelectorAll('.qrwrap').length;") == 0, view(pg))
    pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.x').click()")
    mount(pg, {'data-to': ADDR, 'data-amount-fiat': '25', 'data-currency': 'EUR'}, {'rateSources': 1}); click(pg)
    ok = wait(pg, "(() => { const h = document.querySelector('[data-kallubi-modal]'); const d = h && h.shadowRoot.querySelector('.modal'); return d && d.dataset.view === 'rate'; })()", 15000)
    check('rate-check disagreement is never ignored, not even with rateSources: 1', ok)
    pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.x').click()")
    woc.woc_usd = 22.4                                               # 20.36 EUR vs 20 EUR = 1.8 % -> ok
    mount(pg, {'data-to': ADDR, 'data-amount-fiat': '25', 'data-currency': 'EUR'}); click(pg)
    ok = wait(pg, "(() => { const h = document.querySelector('[data-kallubi-modal]'); const d = h && h.shadowRoot.querySelector('.modal'); return d && d.dataset.view === 'waiting'; })()", 15000)
    check('rate-check sources 1.8 % apart -> quote from CoinGecko (25.00 EUR at 20 = 1.25 BSV)', ok and mq(pg, "return r.querySelector('.amt .v').dataset.amount;").startswith('1.25'), mq(pg, "return r.querySelector('.amt .v') && r.querySelector('.amt .v').dataset.amount;"))
    u = pg.evaluate("[KallubiPay.util.rateMicro(0.49), KallubiPay.util.rateMicro(100001), KallubiPay.util.rateMicro(50), KallubiPay.util.ratesAgree(20000000, 20600000), KallubiPay.util.ratesAgree(20000000, 20700000)]")
    check('rate-check tighter bounds (0.50..100000) and 3 % agreement rule', u == [None, None, 50000000, True, False], u)
    ctx.close()
    chain = MockChain(SCRIPT); chain.woc_usd = 40.0
    ctx, pg, woc, errs, ext = page(chain=chain)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000'}); click(pg); pg.wait_for_timeout(3500)
    woc.pay_sats = inv_sats(pg); woc.phase = 'mempool'
    ok = wait(pg, EV('kallubi:seen') + ' || ' + EV('kallubi:paid'), 15000); e = events(pg)
    check('rate-check BSV price + disagreeing rates -> no 0-conf line, waits for 1 confirmation (safe side)', ok and events(pg, 'kallubi:seen') and not events(pg, 'kallubi:paid') and events(pg, 'kallubi:seen')[0]['d']['confirmationRequired'] is True, [x['type'] for x in e])
    ctx.close()

    # ======================================================================= smaller notes
    # shipping address not in bubbling/composed DOM events (default); callbacks get it
    ctx, pg, woc, errs, ext = page()
    pg.evaluate("() => { window.__ship = []; KallubiPay.on('shipping', function (d) { window.__ship.push(d); }); window.__paidcb = []; KallubiPay.onPaid(function (d) { window.__paidcb.push(d); }); }")
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '800', 'data-shipping': '1'}); click(pg)
    wait(pg, "(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view === 'shipping'; })()", 5000)
    mq(pg, """const v = {name: 'Erika Example', street: 'Teststr. 1', postalCode: '12345', city: 'Teststadt', country: 'DE'};
      for (const k in v) { const i = r.querySelector('[name=' + k + ']'); i.value = v[k]; i.dispatchEvent(new Event('input')); } r.querySelector('form.sf button[type=submit]').click(); return 1;""")
    wait(pg, EV('kallubi:paid'), 8000); pg.wait_for_timeout(200)
    dom = [e['d'] for e in events(pg) if e['type'] in ('kallubi:shipping', 'kallubi:paid')]
    cbs = pg.evaluate('window.__ship.concat(window.__paidcb)')
    check('hardening: bubbling kallubi:shipping / kallubi:paid events carry no address (shippingProvided: true instead)',
          len(dom) == 2 and all('shipping' not in d and d.get('shippingProvided') is True for d in dom), dom)
    check('hardening: KallubiPay.on("shipping") / onPaid callbacks receive the full address', len(cbs) == 2 and all(c.get('shipping', {}).get('name') == 'Erika Example' for c in cbs), cbs)
    ctx.close()

    # ======================================================================= status fail-closed (found 26.11. with live 429s)
    # The raw tx is readable but the status endpoints (confirmations / block time) answer 429, 503 or HTML: never a match.
    ANY = "window.__ev.some(e => ['kallubi:seen', 'kallubi:paid', 'kallubi:overpaid'].includes(e.type))"
    for mode in ('429', '503', 'html'):
        ctx, pg, woc, errs, ext = page()
        mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000'}); click(pg); pg.wait_for_timeout(2000)
        woc.status_mode = mode; woc.pay_sats = inv_sats(pg); woc.phase = 'mempool'
        hit = wait(pg, ANY, 7000)
        check('status fail-closed (%s): exact payment, status unavailable -> no seen / paid, dialog keeps waiting' % mode, not hit and view(pg) == 'waiting' and not errs, [view(pg), [e['type'] for e in events(pg)], errs])
        woc.status_mode = None
        check('status fail-closed (%s): status back -> the same payment is detected (re-checked, not dropped)' % mode, wait(pg, ANY, 15000), [e['type'] for e in events(pg)])
        ctx.close()
    # old confirmed tx (mined 2 h before the invoice) that is not in the baseline: status first 429, then answered
    ctx, pg, woc, errs, ext = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000'}); click(pg); pg.wait_for_timeout(2000)
    woc.status_mode = '429'; woc.blocktime = int(time.time()) - 7200; woc.pay_sats = inv_sats(pg); woc.phase = 'confirmed'
    hit1 = wait(pg, ANY, 7000); woc.status_mode = None; hit2 = wait(pg, ANY, 7000)
    check('status fail-closed: old tx + status 429 is not matched; once the status answers, the age check rejects it (never paid)', not hit1 and not hit2 and not events(pg, 'kallubi:paid'), [hit1, hit2, [e['type'] for e in events(pg)]])
    ctx.close()
    # worker path: the worker lists the tx, but the chain status is unavailable -> no match until the status answers
    ctx, pg, woc, errs, ext = page()
    def api2(route):
        ms = [{'txid': woc.txid, 'sats': woc.pay_sats, 'confirmations': 0, 'exact': True}] if woc.known() else []
        route.fulfill(status=200, body=json.dumps({'ok': True, 'matches': ms}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
    ctx.route('https://check2.example-shop.test/**', api2)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000'}, {'api': 'https://check2.example-shop.test/api/pay/check'}); click(pg); pg.wait_for_timeout(2000)
    woc.status_mode = '429'; woc.pay_sats = inv_sats(pg); woc.phase = 'mempool'
    hit = wait(pg, ANY, 7000); woc.status_mode = None
    check('status fail-closed worker path: status 429 -> no match; status back -> detected', not hit and wait(pg, ANY, 15000), [hit, [e['type'] for e in events(pg)]])
    ctx.close()

    # DOM clobbering
    ctx, pg, woc, errs, ext = page('/tests/v130-clobber.html', ready="document.querySelector('#w .kallubi-pay-host')")
    st = pg.evaluate("[typeof KallubiPay.mount, KallubiPay.version, KallubiPay instanceof Node, KallubiPay.config().allowedTo]")
    check('hardening DOM clobbering: <form id=KallubiPay><input name=version> does not stop the init; clobbered KallubiPayConfig / currentScript ignored',
          st == ['function', '1.3.0', False, None] and 'Pay with BSV' in (host_text(pg) or '') and not errs, [st, errs])
    pg.evaluate("() => { try { window.KallubiPay = {version: 'x'}; } catch (e) {} try { KallubiPay.util.amountMatch = function () { return 'exact'; }; } catch (e) {} }")
    st = pg.evaluate("[KallubiPay.version, KallubiPay.util.amountMatch(60000, 50000, false)]")
    check('hardening: API object is frozen (cannot be replaced or patched after load)', st == ['1.3.0', 'over'], st)
    ctx.close()

    # closed shadow root (opt-in)
    ctx, pg, woc, errs, ext = page()
    pg.evaluate("KallubiPay.config({closedShadow: true})")
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1'}, wait_host=False); pg.wait_for_timeout(500)
    st = pg.evaluate("(() => { const h = document.querySelector('#w .kallubi-pay-host'); return [!!h, h && h.shadowRoot === null]; })()")
    check('hardening closedShadow: true -> host has no readable shadowRoot', st == [True, True], st)
    ctx.close()

    # unchanged default embed: the simple one-line embed still auto-mounts and works (no script-tag settings)
    ctx, pg, woc, errs, ext = page('/tests/blank.html')
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '600'}); click(pg)
    check('compat: simple embed without any new setting still works (auto-mount, test payment -> paid)', wait(pg, EV('kallubi:paid'), 6000) and not errs, errs)
    ctx.close()

passed = sum(1 for r in results if r['ok']); failed = len(results) - passed
print(json.dumps({'passed': passed, 'failed': failed}))
os.makedirs('tests', exist_ok=True)
json.dump(results, open('tests/results-v130.json', 'w'), indent=1)
sys.exit(1 if failed else 0)
