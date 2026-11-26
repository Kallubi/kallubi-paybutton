"""Mocked tests for data-confirm-above (0-conf vs. wait for 1 confirmation). Both chain sources (own node + fallback) are mocked with
Playwright route() (tests/mockchain.py), so these run offline and deterministic.
Run:  python3 -m http.server 8765 --bind 127.0.0.1 &   then   python tests/test_confirm.py"""
import json, time, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765'
ADDR = '1111111111111111111114oLvT2'
SCRIPT = '76a914' + '00' * 20 + '88ac'
results = []
DEBUG = "-v" in sys.argv
def check(name, cond, info=''):
    results.append({'test': name, 'ok': bool(cond), 'info': info})
    print(('PASS ' if cond else 'FAIL ') + name + (('  [' + str(info) + ']') if info != '' else ''))

from mockchain import MockChain, MockBroadcaster
def Woc(): return MockChain(SCRIPT)

def view(pg):
    return pg.evaluate("(() => { const h = document.querySelector('[data-kallubi-modal]'); const d = h && h.shadowRoot.querySelector('.modal'); return d && d.getAttribute('data-view'); })()")
def mtext(pg, sel):
    return pg.evaluate("(s) => { const h = document.querySelector('[data-kallubi-modal]'); const n = h && h.shadowRoot.querySelector(s); return n && n.textContent; }", sel)
def mount(pg, attrs):
    pg.evaluate("""(a) => { const s = document.getElementById('slot'); s.textContent = ''; const d = document.createElement('div');
      d.setAttribute('data-kallubi-pay', ''); d.id = 'w'; const T = {'data-node': 'node', 'data-api': 'api', 'data-quick-ms': 'quickMs', 'data-fallback-url': 'fallbackUrl', 'data-broadcaster-url': 'broadcasterUrl', 'data-shipping-url': 'shippingUrl', 'data-shipping-email': 'shippingEmail'}; const o = Object.assign({}, a.__opts || {}); let use = !!a.__opts; for (const k in a) { if (k === '__opts') continue; if (T[k] && !(k === 'data-node' && a[k] === '')) { o[T[k]] = a[k]; use = true; } else d.setAttribute(k, a[k]); } if ('data-shipping' in a && !('shippingInEvents' in o)) { o.shippingInEvents = true; use = true; } if (use) KallubiPay.mount(d, o); s.appendChild(d); /* v1.3.0: trusted settings via KallubiPay.mount options */ }""", attrs)
    pg.wait_for_function("document.querySelector('#w .kallubi-pay-host')")
def click(pg):
    pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').click()")
def btn_text(pg):
    return pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').textContent")
def invoice_sats(pg):
    return round(float(pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('[data-amount]').getAttribute('data-amount')")) * 1e8)
def events(pg, t=None):
    return [e for e in pg.evaluate('window.__ev') if t is None or e['type'] == t]
def wait(pg, js, ms):
    try: pg.wait_for_function(js, timeout=ms); return True
    except Exception: return False

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    def page():
        ctx = b.new_context(viewport={'width': 1100, 'height': 900}); woc = Woc()
        woc.route_all(ctx)
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/tests/blank.html'); pg.wait_for_function('window.KallubiPay')
        return ctx, pg, woc, errs

    # --- unit: threshold parsing
    ctx, pg, woc, errs = page()
    u = pg.evaluate("['0','0.0','0.01','1','21000000','abc','-1','0.000000001'].map(KallubiPay.util.parseThreshold)")
    check('parse: data-confirm-above values', u == [0, 0, 1000000, 100000000, 2100000000000000, None, None, None], u)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.001', 'data-confirm-above': 'abc'})
    e = pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.textContent")
    check('validation: bad data-confirm-above shows an error', 'invalid data-confirm-above' in e, e[:90])
    ctx.close()

    # --- path 1: small BSV amount (under the 20 EUR fallback) -> paid at 0-conf
    ctx, pg, woc, errs = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.005', 'data-merchant': 'Mock Shop', 'data-order': 'M-1', 'data-poll-ms': '1000'})
    click(pg); pg.wait_for_timeout(int(1.5 * 1000))
    woc.pay_sats = invoice_sats(pg); woc.phase = 'mempool'
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 15000)
    p = events(pg, 'kallubi:paid')
    d = p[0]['d'] if p else {}
    check('0-conf path: paid on "Seen on network" below the threshold', ok and view(pg) == 'paid' and mtext(pg, '.pill') == 'Seen on network', [view(pg), mtext(pg, '.pill')])
    check('0-conf path: event has confirmation info (confirmed:false, confirmations:0)',
          d.get('txid') == woc.txid and d.get('confirmed') is False and d.get('confirmations') == 0 and d.get('confirmationRequired') is False and d.get('confirmAboveSats') == 1000000000 and d.get('confirmAboveFiat') == '200.00' and d.get('order') == 'M-1', d)
    check('0-conf path: no kallubi:seen event, no JS errors', not events(pg, 'kallubi:seen') and not errs, errs)
    ctx.close()

    # --- path 2: at/above the threshold -> "Payment seen – waiting for 1 confirmation", never expires, then paid confirmed:true
    ctx, pg, woc, errs = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.02', 'data-confirm-above': '0.01', 'data-merchant': 'Mock Shop', 'data-order': 'M-2', 'data-ttl': '6', 'data-poll-ms': '1000', 'data-theme': 'dark'})
    click(pg); pg.wait_for_timeout(int(1.5 * 1000))
    woc.pay_sats = invoice_sats(pg); woc.phase = 'mempool'
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:seen')", 15000)
    w1 = mtext(pg, '.wait .w1')
    check('confirm path: modal shows "Payment seen – waiting for 1 confirmation (~10 min)"', ok and view(pg) == 'confirming' and w1 == 'Payment seen \u2013 waiting for 1 confirmation (~10 min)', [view(pg), w1])
    st = pg.evaluate("""(() => { const r = document.querySelector('[data-kallubi-modal]').shadowRoot; const w = r.querySelector('.wait'), s = r.querySelector('.spin'), c = r.querySelector('.check'), p = r.querySelector('.pill');
      return [getComputedStyle(w).borderTopColor, getComputedStyle(s).borderTopColor, getComputedStyle(c).backgroundImage.slice(0, 60), getComputedStyle(p).backgroundImage.slice(0, 60), p.textContent]; })()""")
    check('confirm path: same gold style (gold border, gold spinner, gold check + pill)', '240, 193, 75' in st[0] and st[1] == 'rgb(240, 193, 75)' and '245, 215, 110' in st[2] and '245, 215, 110' in st[3] and st[4] == 'Seen · 0 / 1 conf', st)
    sd = events(pg, 'kallubi:seen')[0]['d']
    check('confirm path: kallubi:seen event (confirmed:false, confirmationRequired:true)', sd['txid'] == woc.txid and sd['confirmed'] is False and sd['confirmationRequired'] is True, sd)
    check('confirm path: no kallubi:paid yet', not events(pg, 'kallubi:paid'))
    n0 = sum(1 for c in woc.calls if c.startswith('/tx/') and not c.endswith('/hex'))
    pg.wait_for_timeout(int(7.5 * 1000))    # well past the 6 s payment window
    check('confirm path: countdown does NOT expire a payment that was already seen', view(pg) == 'confirming' and not events(pg, 'kallubi:paid'), view(pg))
    tx_polls = sum(1 for c in woc.calls if c.startswith('/tx/') and not c.endswith('/hex')) - n0
    check('confirm path: keeps polling the seen tx for its confirmation (every 3x poll interval)', tx_polls >= 2, tx_polls)
    # close + reopen while waiting for the confirmation
    pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.x').click()")
    bt = btn_text(pg); click(pg)
    check('confirm path: closing + reopening shows the confirming view again', 'Payment seen' in bt and view(pg) == 'confirming', [bt, view(pg)])
    woc.phase = 'confirmed'
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 15000)
    p = events(pg, 'kallubi:paid'); d = p[0]['d'] if p else {}
    check('confirm path: after 1 confirmation -> kallubi:paid with confirmed:true', ok and len(p) == 1 and d.get('confirmed') is True and d.get('confirmations') == 1 and d.get('confirmationRequired') is True and d.get('sats') == woc.pay_sats, d)
    check('confirm path: success view says "Confirmed"', view(pg) == 'paid' and (mtext(pg, '.pill') or '').startswith('Confirmed'), mtext(pg, '.pill'))
    check('confirm path: no JS errors', not errs, errs)
    ctx.close()

    # --- path 3: already confirmed when first seen (big amount) -> paid straight away, confirmed:true
    ctx, pg, woc, errs = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.5', 'data-poll-ms': '1000'})
    click(pg); pg.wait_for_timeout(int(1.5 * 1000))
    woc.pay_sats = invoice_sats(pg); woc.phase = 'confirmed_first'
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 20000)
    p = events(pg, 'kallubi:paid'); d = p[0]['d'] if p else {}
    check('already confirmed tx above threshold -> paid directly (confirmations 3)', ok and d.get('confirmed') is True and d.get('confirmations') == 3 and not events(pg, 'kallubi:seen'), d)
    ctx.close()

    # --- test mode, data-confirm-above="0" (always wait) and a very high value (always 0-conf)
    ctx, pg, woc, errs = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0001', 'data-test': '1', 'data-test-delay': '600', 'data-test-confirm-delay': '2500', 'data-confirm-above': '0'})
    click(pg)
    ok1 = wait(pg, "window.__ev.some(e => e.type === 'kallubi:seen')", 5000); v1 = view(pg)
    ok2 = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 6000)
    d = events(pg, 'kallubi:paid')[0]['d'] if ok2 else {}
    check('data-confirm-above="0": even a tiny amount waits for 1 confirmation (test mode)', ok1 and v1 == 'confirming' and ok2 and d.get('confirmed') is True and d.get('test') is True, [v1, d])
    pg.evaluate("window.__ev=[]")
    mount(pg, {'data-to': ADDR, 'data-amount': '50', 'data-test': '1', 'data-test-delay': '600', 'data-confirm-above': '21000000'})
    click(pg)
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 5000)
    d = events(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('data-confirm-above="21000000": 50 BSV accepted at 0-conf', ok and d.get('confirmed') is False and not events(pg, 'kallubi:seen'), d)
    check('test mode: no network requests at all', woc.calls == [], woc.calls)
    ctx.close()

    # --- quick check (own node + BSV Broadcaster): mid-range 0-conf vs. fallback wait vs. double-spend
    def midrange(arc_mode, quick_ms='3000'):
        ctx = b.new_context(viewport={'width': 1100, 'height': 900}); woc = Woc(); woc.node = 'index'; woc.route_all(ctx)
        arc = MockBroadcaster(arc_mode); arc.route(ctx)
        pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/tests/blank.html'); pg.wait_for_function('window.KallubiPay')
        # 2 BSV at the stubbed 20 EUR/BSV rate = 40 EUR: above the 20 EUR fallback, under the 200 EUR line
        mount(pg, {'data-to': ADDR, 'data-amount': '2', 'data-poll-ms': '1000', 'data-quick-ms': quick_ms, 'data-node': 'https://node.kallubi-bsv-explorer.de/v1/bsv/main'})
        click(pg); pg.wait_for_timeout(int(1.5 * 1000))
        woc.pay_sats = invoice_sats(pg); woc.phase = 'mempool'
        return ctx, pg, woc, arc, errs

    ctx, pg, woc, arc, errs = midrange('ok')
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 12000)
    d = events(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('quick check: 40 EUR equivalent, node + Broadcaster SEEN_ON_NETWORK -> paid at 0-conf',
          ok and d.get('confirmed') is False and d.get('quickCheck', {}).get('ok') is True and d.get('quickCheck', {}).get('txStatus') == 'SEEN_ON_NETWORK' and not errs, [d, errs])
    ctx.close()

    def wait_checked(pg):
        wait(pg, "window.__ev.some(e => e.type === 'kallubi:seen')", 12000)
        wait(pg, "(() => { const h = document.querySelector('[data-kallubi-modal]'); const v = h && h.shadowRoot.querySelector('.modal') && h.shadowRoot.querySelector('.modal').dataset.view; return v && v !== 'checking'; })()", 10000)
        return view(pg) == 'confirming' and not events(pg, 'kallubi:paid')
    ctx, pg, woc, arc, errs = midrange('down')
    still = wait_checked(pg)
    check('quick check unavailable: 40 EUR equivalent waits for 1 confirmation (no 20 EUR fallback)',
          still, [view(pg), events(pg, 'kallubi:seen')[:1], events(pg, 'kallubi:paid')])
    ctx.close()

    ctx, pg, woc, arc, errs = midrange('doublespend')
    still = wait_checked(pg)
    check('quick check DOUBLE_SPEND_ATTEMPTED: never paid at 0-conf, waits for 1 confirmation',
          still, [view(pg), events(pg, 'kallubi:seen')[:1], events(pg, 'kallubi:paid')])
    ctx.close()

    # --- review 25.11.: data-quick-ms below 3 s is ignored (window stays 5 s), Broadcaster 'pending' never pays mid-range
    ctx, pg, woc, arc, errs = midrange('ok', quick_ms='800')
    wait(pg, "window.__ev.some(e => e.type === 'kallubi:seen')", 12000)
    pg.wait_for_timeout(2500)
    early = bool(events(pg, 'kallubi:paid'))
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 12000)
    check('quick check: data-quick-ms="800" cannot shorten the double-spend window (no paid within 2.5 s, paid after the 5 s window)',
          not early and ok and not errs, [early, ok, errs[:1]])
    ctx.close()
    ctx, pg, woc, arc, errs = midrange('pending')
    still = wait_checked(pg)
    check('quick check: Broadcaster only RECEIVED/ACCEPTED (not SEEN_ON_NETWORK) -> 40 EUR equivalent waits for 1 confirmation',
          still, [view(pg), events(pg, 'kallubi:paid')])
    ctx.close()

    # --- review 25.11.: non-final transactions never count at 0-conf (not even within the 20 EUR fallback)
    def small(seq, locktime):
        ctx = b.new_context(viewport={'width': 1100, 'height': 900}); woc = Woc(); woc.node = 'index'; woc.route_all(ctx)
        pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/tests/blank.html'); pg.wait_for_function('window.KallubiPay')
        mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000', 'data-node': 'https://node.kallubi-bsv-explorer.de/v1/bsv/main'})
        click(pg); pg.wait_for_timeout(1500)
        woc.seq = seq; woc.locktime = locktime; woc.pay_sats = invoice_sats(pg); woc.phase = 'mempool'
        return ctx, pg, woc, errs
    ctx, pg, woc, errs = small(0xfffffffe, 900500)          # height lock above the mocked tip (900000)
    seen = wait(pg, "window.__ev.some(e => e.type === 'kallubi:seen')", 12000); pg.wait_for_timeout(1500)
    sd = events(pg, 'kallubi:seen')[0]['d'] if seen else {}
    check('non-final tx (height lock in the future) at 0.0005 BSV: seen, never paid at 0-conf, reason not_final',
          seen and not events(pg, 'kallubi:paid') and view(pg) == 'confirming' and (sd.get('quickCheck') or {}).get('reason') == 'not_final', [view(pg), sd.get('quickCheck'), events(pg, 'kallubi:paid')])
    ctx.close()
    ctx, pg, woc, errs = small(0xfffffffe, 899999)          # height lock already passed (anti fee sniping style) -> final
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 12000)
    check('tx with nSequence 0xfffffffe and a passed height lock counts as final -> paid at 0-conf (tip read from the node)',
          ok and not errs, [view(pg), errs[:1]])
    ctx.close()
    ctx, pg, woc, errs = small(0xfffffffe, 2000000000)      # time lock far in the future
    seen = wait(pg, "window.__ev.some(e => e.type === 'kallubi:seen')", 12000); pg.wait_for_timeout(1500)
    check('non-final tx (time lock in the future): never paid at 0-conf', seen and not events(pg, 'kallubi:paid'), [view(pg)])
    ctx.close()

    # --- review 25.11.: data-api (check worker) answers are only hints; amount + confirmations come from the raw tx / chain status
    def api_case(worker_sats_delta, chain_sats_delta, worker_conf):
        ctx = b.new_context(viewport={'width': 1100, 'height': 900}); woc = Woc(); woc.node = 'index'; woc.route_all(ctx)
        api_calls = []
        state = {'inv': None}
        def api(route):
            api_calls.append(route.request.url)
            ms = []
            if state['inv'] and woc.known():
                ms = [{'txid': woc.txid, 'sats': state['inv'] + worker_sats_delta, 'confirmations': worker_conf}]
            route.fulfill(status=200, body=json.dumps({'ok': True, 'matches': ms}), headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'})
        ctx.route('https://check.example-shop.test/**', api)
        pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/tests/blank.html'); pg.wait_for_function('window.KallubiPay')
        mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-poll-ms': '1000', 'data-api': 'https://check.example-shop.test/api/pay/check'})
        click(pg); pg.wait_for_timeout(1500)
        state['inv'] = invoice_sats(pg); woc.pay_sats = state['inv'] + chain_sats_delta; woc.phase = 'mempool'
        return ctx, pg, woc, api_calls, errs
    ctx, pg, woc, api_calls, errs = api_case(0, -1, 0)
    paid = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid' || e.type === 'kallubi:seen')", 9000)
    check('data-api: worker claims the full amount, raw tx on chain pays 1 sat less -> never paid', not paid and len(api_calls) > 2, [events(pg), len(api_calls)])
    ctx.close()
    ctx, pg, woc, api_calls, errs = api_case(0, 0, 6)
    ok = wait(pg, "window.__ev.some(e => e.type === 'kallubi:paid')", 12000)
    d = events(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('data-api: worker claims 6 confirmations for a mempool tx -> paid with the chain status (confirmations 0), amount from raw tx',
          ok and d.get('confirmations') == 0 and d.get('confirmed') is False and d.get('sats') == woc.pay_sats and not errs, [d, errs[:1]])
    ctx.close()

    # --- strict CSP (style-src 'none'): styles still apply via constructable stylesheets
    ctx = b.new_context(); pg = ctx.new_page(); cspv = []
    pg.on('console', lambda m: 'Content Security Policy' in m.text and cspv.append(m.text))
    pg.goto(BASE + '/tests/csp.html'); pg.wait_for_function("document.querySelector('#b .kallubi-pay-host')")
    cs = pg.evaluate("(() => { const bt = document.querySelector('#b .kallubi-pay-host').shadowRoot.querySelector('button'); const s = getComputedStyle(bt); return [s.display, s.backgroundImage.slice(0, 40), s.fontSize]; })()")
    check("strict CSP (style-src 'none'): button still fully styled, no CSP violations", cs[0] == 'flex' and 'gradient' in cs[1] and cs[2] == '16px' and not cspv, [cs, cspv[:2]])
    ctx.close()
    b.close()

passed = sum(r['ok'] for r in results)
json.dump(results, open('tests/results-confirm.json', 'w'), indent=1)
print(json.dumps({'passed': passed, 'failed': len(results) - passed}))
sys.exit(0 if passed == len(results) else 1)
