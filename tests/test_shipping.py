"""Optional shipping address (data-shipping="1"). Headless Chrome, offline and deterministic:
Both chain sources are mocked with Playwright route() (tests/mockchain.py); a tiny local mock merchant server receives the POST (real CORS preflight).
Run:  python3 -m http.server 8765 --bind 127.0.0.1 &   then   python tests/test_shipping.py
Prints only test names (no hosts / addresses)."""
import json, os, re, sys, time, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8765'
MPORT = 8799
MERCH = 'http://localhost:%d' % MPORT
ADDR = '1111111111111111111114oLvT2'
SCRIPT = '76a914' + '00' * 20 + '88ac'
HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.environ.get('KALLUBI_SHOTS', os.path.join(HERE, '..', 'shots', ''))
SKIP_SHOTS = os.environ.get('KALLUBI_SKIP_SHOTS') == '1'
BUYER = {'name': 'Erika Mustermann', 'street': 'Musterweg 12', 'postalCode': '12345', 'city': 'Musterstadt', 'country': 'Germany',
         'email': 'erika@example.org', 'note': 'Size L please'}
MARKERS = ['Mustermann', 'Musterweg', 'Musterstadt', 'erika@example', 'Size L']   # must only ever reach the merchant URL
results = []
def check(name, cond, info=''):
    results.append({'test': name, 'ok': bool(cond), 'info': info})
    print(('PASS ' if cond else 'FAIL ') + name + (('  [' + str(info)[:300] + ']') if (info != '' and not cond) else ''))

# ---------------------------------------------------------------- mock merchant (records POST bodies, CORS like a real endpoint)
RECEIVED = []
class Merchant(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Methods', 'POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); body = self.rfile.read(n).decode('utf-8')
        RECEIVED.append({'path': self.path, 'body': body, 'cookie': self.headers.get('Cookie'), 'referer': self.headers.get('Referer'), 'ctype': self.headers.get('Content-Type')})
        code = 500 if self.path.startswith('/fail') else 200
        self.send_response(code); self.cors(); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(b'{"ok":true}' if code == 200 else b'{"ok":false}')
srv = ThreadingHTTPServer(('127.0.0.1', MPORT), Merchant); threading.Thread(target=srv.serve_forever, daemon=True).start()

from mockchain import MockChain, is_chain
def Woc(): return MockChain(SCRIPT, confirmed_list=False)

M = "(f) => { const h = document.querySelector('[data-kallubi-modal]'); return h ? (new Function('r', f))(h.shadowRoot) : null; }"
def modal(pg, js): return pg.evaluate(M, js)
def view(pg): return modal(pg, "const d = r.querySelector('.modal'); return d && d.dataset.view;")
def wait(pg, js, ms=15000):
    try: pg.wait_for_function(js, timeout=ms); return True
    except Exception: return False
def W(v): return "(() => { const h = document.querySelector('[data-kallubi-modal]'); return !!h && h.shadowRoot.querySelector('.modal').dataset.view === '%s'; })()" % v
def mount(pg, attrs):
    pg.evaluate("""(a) => { const s = document.getElementById('slot'); s.textContent = ''; const d = document.createElement('div');
      d.setAttribute('data-kallubi-pay', ''); d.id = 'w'; const T = {'data-node': 'node', 'data-api': 'api', 'data-quick-ms': 'quickMs', 'data-fallback-url': 'fallbackUrl', 'data-broadcaster-url': 'broadcasterUrl', 'data-shipping-url': 'shippingUrl', 'data-shipping-email': 'shippingEmail'}; const o = Object.assign({}, a.__opts || {}); let use = !!a.__opts; for (const k in a) { if (k === '__opts') continue; if (T[k] && !(k === 'data-node' && a[k] === '')) { o[T[k]] = a[k]; use = true; } else d.setAttribute(k, a[k]); } if ('data-shipping' in a && !('shippingInEvents' in o)) { o.shippingInEvents = true; use = true; } if (use) KallubiPay.mount(d, o); s.appendChild(d); /* v1.3.0: trusted settings via KallubiPay.mount options */ window.__ev = []; }""", attrs)
    pg.wait_for_function("document.querySelector('#w .kallubi-pay-host')")
def click(pg): pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').click()")
def close(pg):
    for _ in range(3):
        if not pg.evaluate("document.querySelectorAll('[data-kallubi-modal]').length"): break
        pg.keyboard.press('Escape'); pg.wait_for_timeout(150)
def fill(pg, vals):
    modal(pg, "const v = %s; for (const k in v) { const i = r.querySelector('[name=' + k + ']'); i.value = v[k]; i.dispatchEvent(new Event('input')); } return 1;" % json.dumps(vals))
def submit(pg): modal(pg, "r.querySelector('form.sf button[type=submit]').click(); return 1;")
def events(pg, t): return pg.evaluate("(t) => window.__ev.filter(e => e.type === t).map(e => e.d)", t)

# structural snapshot of a shadow root: tags, classes, roles, texts; random numbers and the QR path are normalised
SNAP = r"""(r) => { const out = []; const w = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { if (n.nodeType === 3) { const v = n.nodeValue.trim(); if (v && !n.parentElement.closest('style')) out.push('#' + v.replace(/[0-9a-f]{64}/g, 'TX').replace(/[0-9a-f]{4,}…[0-9a-f]{4,}/g, 'TXS').replace(/\d+/g, '9')); }
    else if (n.namespaceURI !== 'http://www.w3.org/2000/svg' || n.tagName === 'svg') { if (n.tagName === 'STYLE') continue;
      out.push('<' + n.tagName.toLowerCase() + ' ' + (n.getAttribute('class') || '') + ' ' + (n.getAttribute('role') || '') + ' ' + (n.getAttribute('aria-label') || '').replace(/\d/g, '9') + '>'); } }
  return out.join('\n'); }"""
def snap_btn(pg): return pg.evaluate("(f) => (eval(f))(document.querySelector('#w .kallubi-pay-host').shadowRoot)", SNAP)
def snap_modal(pg): return pg.evaluate("(f) => { const h = document.querySelector('[data-kallubi-modal]'); return h ? (eval(f))(h.shadowRoot) : null; }", SNAP)

T = {'data-to': ADDR, 'data-amount': '0.0005', 'data-label': 'Gold Logo Hoodie', 'data-merchant': 'Merch Shop', 'data-order': 'MS-7',
     'data-test': '1', 'data-test-delay': '1500', 'data-theme': 'dark'}

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    ctx = b.new_context(viewport={'width': 1280, 'height': 900})
    pg = ctx.new_page(); errors = []; reqs = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errors.append(m.text))
    pg.on('request', lambda r: reqs.append({'url': r.url, 'method': r.method, 'post': r.post_data or ''}))
    woc = Woc(); woc.route_all(pg)

    # ------------------------------------------------------------ 1. shipping OFF = identical to v1.2.1
    OFFCFGS = [dict(T), dict(T, **{'data-theme': 'light', 'data-lang': 'de'}), dict(T, **{'data-amount': '0.02', 'data-confirm-above': '0.01', 'data-test-confirm-delay': '1500', 'data-style': 'outline'})]
    snaps = {}
    # v1.2.0 adds these keys to every event (additive only; all old keys keep their meaning and order)
    V14_KEYS = ['confirmAboveFiat', 'orderId', 'orderIdGenerated', 'tag', 'createdAt', 'expiresAt', 'serverVerify']
    added = []
    for ver, page in (('old', '/tests/blank-v121.html'), ('new', '/tests/ship.html')):
        pg.goto(BASE + page); pg.wait_for_function('window.KallubiPay')
        ss = []
        for cfg in OFFCFGS:
            mount(pg, cfg); ss.append(snap_btn(pg)); click(pg); wait(pg, W('waiting')); ss.append(snap_modal(pg))
            ok = wait(pg, W('paid'), 12000); ss.append(snap_modal(pg) if ok else 'NOPAID'); ss.append(snap_btn(pg))
            ev = pg.evaluate("window.__ev.filter(e => e.type === 'kallubi:paid').map(e => Object.keys(e.d).filter(k => !%s.includes(k)).join(','))" % json.dumps(V14_KEYS)); ss.append(json.dumps(ev))
            if ver == 'new': added.append(pg.evaluate("window.__ev.filter(e => e.type === 'kallubi:paid').map(e => Object.keys(e.d).filter(k => %s.includes(k)).join(','))" % json.dumps(V14_KEYS)))
            close(pg)
        mount(pg, dict(T, **{'data-to': '1BAD'})); ss.append(snap_btn(pg))
        snaps[ver] = ss
    names = ['button', 'waiting', 'paid', 'button after paid', 'paid event keys']
    check('v1.2.0: paid event only ADDS orderId/orderIdGenerated/tag/createdAt/expiresAt/serverVerify/confirmAboveFiat', len(added) == 3 and all(a == [','.join(V14_KEYS)] for a in added), added)
    for i, (o, n) in enumerate(zip(snaps['old'], snaps['new'])):
        nm = 'config error' if i == len(snaps['old']) - 1 else 'cfg%d %s' % (i // 5 + 1, names[i % 5])
        check('off = v1.2.1: ' + nm, o == n and o != 'NOPAID', '' if o == n else [l for l in __import__('difflib').unified_diff(o.split('\n'), n.split('\n'), lineterm='', n=1)][2:14])
    pg.goto(BASE + '/tests/ship.html'); pg.wait_for_function('window.KallubiPay')
    check('version 1.3.0', pg.evaluate('KallubiPay.version') == '1.3.0')
    mount(pg, T); click(pg); wait(pg, W('waiting'))
    check('off: dialog opens straight in the QR step (no form)', view(pg) == 'waiting' and not modal(pg, "return !!r.querySelector('form')"))
    close(pg)

    # ------------------------------------------------------------ 2. config validation
    for nm, extra, want in (('http:// URL rejected', {'data-shipping-url': 'http://shop.example/x'}, 'data-shipping-url'),
                            ('javascript: URL rejected', {'data-shipping-url': 'javascript:alert(1)'}, 'data-shipping-url'),
                            ('URL with user:password@ rejected', {'data-shipping-url': 'https://u:p@shop.example/x'}, 'data-shipping-url'),
                            ('mailto injection rejected', {'data-shipping-email': 'shop@example.org?cc=evil@example.org'}, 'data-shipping-email'),
                            ('email with spaces rejected', {'data-shipping-email': 'a b@example.org'}, 'data-shipping-email')):
        mount(pg, dict(T, **{'data-shipping': '1'}, **extra))
        err = pg.evaluate("(() => { const e = document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('.err'); return e && e.textContent })()")
        check('config: ' + nm, bool(err) and want in err, err)
    mount(pg, dict(T, **{'data-shipping-url': 'javascript:alert(1)'}))   # attributes are ignored while data-shipping is off
    check('config: shipping attributes ignored when data-shipping is off', pg.evaluate("!document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('.err')"))
    U = pg.evaluate("[KallubiPay.util.isEmail('shop@example.org'), KallubiPay.util.isEmail('x@y'), KallubiPay.util.shipUrlHost('https://forms.example.com/f/abc'), KallubiPay.util.shipUrlHost('http://evil.example/')]")
    check('util: isEmail / shipUrlHost', U == [True, False, 'forms.example.com', None], U)

    # ------------------------------------------------------------ 3. form + validation (test mode, POST to mock merchant)
    reqs.clear(); RECEIVED.clear()
    mount(pg, dict(T, **{'data-shipping': '1', 'data-shipping-url': MERCH + '/orders'}))
    click(pg); wait(pg, W('shipping'))
    f = modal(pg, """return { view: r.querySelector('.modal').dataset.view, fields: Array.from(r.querySelectorAll('form .in')).map(i => i.name + ':' + (i.getAttribute('aria-required') || '') + ':' + i.getAttribute('autocomplete')),
      labels: Array.from(r.querySelectorAll('form label')).map(l => l.textContent), priv: r.querySelector('.priv').textContent, h: r.querySelector('.sh').textContent,
      btn: r.querySelector('form button[type=submit]').textContent, qr: !!r.querySelector('.qrwrap'), amt: r.querySelector('.samt').textContent }""")
    check('form: shown first, before the QR step', f['view'] == 'shipping' and not f['qr'], f['view'])
    check('form: 7 fields, 5 required, autocomplete hints', f['fields'] == ['name:true:shipping name', 'street:true:shipping street-address', 'postalCode:true:shipping postal-code',
          'city:true:shipping address-level2', 'country:true:shipping country-name', 'email::email', 'note::off'], f['fields'])
    check('form: privacy note names the merchant and the receiving host', 'only to Merch Shop' in f['priv'] and 'never to Kallubi' in f['priv'] and 'localhost' in f['priv'], f['priv'])
    check('form: heading, amount, button', f['h'] == 'Shipping address' and '0.0005 BSV' in f['amt'] and f['btn'] == 'Continue to payment', [f['h'], f['amt'], f['btn']])
    check('form: no invoice / no network before submit', not any(is_chain(q['url']) or ':%d' % MPORT in q['url'] for q in reqs))
    submit(pg)
    v = modal(pg, "return { view: r.querySelector('.modal').dataset.view, inv: Array.from(r.querySelectorAll('.in[aria-invalid=true]')).map(i => i.name), errs: Array.from(r.querySelectorAll('.fe')).map(e => e.textContent).filter(Boolean), ferr: r.querySelector('.ferr').textContent, focus: r.activeElement && r.activeElement.name }")
    check('validation: empty form blocked, 5 required fields marked', v['view'] == 'shipping' and v['inv'] == ['name', 'street', 'postalCode', 'city', 'country'] and v['errs'] == ['Required'] * 5, v)
    check('validation: summary message + focus on first invalid field', v['ferr'] == 'Please check the marked fields.' and v['focus'] == 'name', [v['ferr'], v['focus']])
    fill(pg, dict(BUYER, email='not-an-email')); submit(pg)
    v = modal(pg, "return { view: r.querySelector('.modal').dataset.view, inv: Array.from(r.querySelectorAll('.in[aria-invalid=true]')).map(i => i.name), e: r.querySelector('#kp-f-email-e').textContent }")
    check('validation: invalid optional email blocked', v['view'] == 'shipping' and v['inv'] == ['email'] and v['e'] == 'Please enter a valid email address', v)
    fill(pg, {'email': ''}); fill(pg, {'name': '   '}); submit(pg)
    check('validation: whitespace-only counts as empty', modal(pg, "return Array.from(r.querySelectorAll('.in[aria-invalid=true]')).map(i => i.name)") == ['name'])
    fill(pg, BUYER); submit(pg)
    check('submit: goes on to the QR step', wait(pg, W('waiting'), 3000))
    sev = events(pg, 'kallubi:shipping')
    check('event kallubi:shipping carries the address + order facts', len(sev) == 1 and sev[0]['shipping'] == BUYER and sev[0]['order'] == 'MS-7' and sev[0]['merchant'] == 'Merch Shop'
          and 50001 <= sev[0]['requestedSats'] <= 50099 and sev[0]['tag'] == sev[0]['requestedSats'] - 50000, sev)
    row = modal(pg, "return r.querySelector('.shiprow .sv').textContent")
    check('waiting view: "Ship to" summary row', row == 'Erika Mustermann, 12345 Musterstadt, Germany', row)
    amt1 = modal(pg, "return r.querySelector('.amt .v').dataset.amount")
    modal(pg, "r.querySelector('.shiprow .lnk').click(); return 1")
    pref = modal(pg, "return [r.querySelector('.modal').dataset.view, r.querySelector('[name=city]').value]")
    check('edit: form reopens prefilled', pref == ['shipping', 'Musterstadt'], pref)
    fill(pg, {'city': 'Neustadt'}); submit(pg); wait(pg, W('waiting'), 3000)
    amt2 = modal(pg, "return r.querySelector('.amt .v').dataset.amount")
    check('edit: same invoice kept (amount unchanged), event re-sent with new city', amt1 == amt2 and events(pg, 'kallubi:shipping')[-1]['shipping']['city'] == 'Neustadt', [amt1, amt2])
    modal(pg, "r.querySelector('.shiprow .lnk').click(); return 1"); fill(pg, {'city': 'Musterstadt'}); submit(pg); wait(pg, W('waiting'), 3000)
    ok = wait(pg, W('paid'), 12000)
    check('test payment completes', ok)
    wait(pg, "window.__ev.some(e => e.type === 'kallubi:shipping-sent')", 8000)
    pev = events(pg, 'kallubi:paid')
    check('kallubi:paid detail contains the address', len(pev) == 1 and pev[0]['shipping'] == BUYER and pev[0]['test'] is True, pev)
    sent = events(pg, 'kallubi:shipping-sent')
    check('kallubi:shipping-sent ok=true status 200', len(sent) == 1 and sent[0]['ok'] is True and sent[0]['status'] == 200, sent)
    check('mock merchant received exactly one POST', len(RECEIVED) == 1, len(RECEIVED))
    if RECEIVED:
        body = json.loads(RECEIVED[0]['body'])
        check('POST payload: txid, amount, tag, label, merchant, order, address', body['txid'] == pev[0]['txid'] and body['sats'] == pev[0]['sats'] and body['tag'] == body['requestedSats'] - 50000
              and body['label'] == 'Gold Logo Hoodie' and body['merchant'] == 'Merch Shop' and body['order'] == 'MS-7' and body['shipping'] == BUYER and body['test'] is True
              and body['kallubi'] == 'shipping' and body['version'] == '1.3.0' and re.match(r'^MS-7$', body['orderId']) and body['serverVerify'] == 'required', body)
        check('POST: JSON, no cookies, no referrer', RECEIVED[0]['ctype'] == 'application/json' and not RECEIVED[0]['cookie'] and not RECEIVED[0]['referer'], RECEIVED[0])
    pv = modal(pg, "return { s: r.querySelector('.shipbox') && r.querySelector('.shipbox').textContent, row: Array.from(r.querySelectorAll('.row')).map(x => x.textContent).join(' | '), mail: !!r.querySelector('[data-mailto]') }")
    check('paid view: "Address sent to the shop" + Ship-to row', pv['s'] == 'Address sent to the shop \u2713' and 'Ship toErika Mustermann, Musterstadt' in pv['row'] and not pv['mail'], pv)
    close(pg)

    # ------------------------------------------------------------ 4. merchant URL fails -> mailto fallback
    RECEIVED.clear()
    mount(pg, dict(T, **{'data-shipping': '1', 'data-shipping-url': MERCH + '/fail', 'data-shipping-email': 'orders@merch-shop.example'}))
    click(pg); wait(pg, W('shipping')); fill(pg, BUYER); submit(pg); wait(pg, W('paid'), 12000)
    wait(pg, "window.__ev.some(e => e.type === 'kallubi:shipping-sent')", 8000); pg.wait_for_timeout(200)
    fb = modal(pg, "const a = r.querySelector('[data-mailto]'); return { s: r.querySelector('.shs') && r.querySelector('.shs').textContent, href: a && a.getAttribute('href'), txt: a && a.textContent }")
    sent = events(pg, 'kallubi:shipping-sent'); txid = events(pg, 'kallubi:paid')[0]['txid']
    check('URL fails (HTTP 500): shipping-sent ok=false, message shown', bool(sent) and sent[0]['ok'] is False and sent[0]['status'] == 500 and fb['s'] == 'Your address could not be sent automatically.', [sent, fb['s']])
    href = fb['href'] or ''
    q = parse_qs(urlparse(href).query) if href else {}
    check('mailto fallback: to the shop, subject with order, body with address + txid', href.startswith('mailto:orders@merch-shop.example?subject=') and q.get('subject') == ['Order #MS-7: shipping address']
          and 'Erika Mustermann' in q['body'][0] and 'Musterweg 12' in q['body'][0] and txid in q['body'][0] and set(q) == {'subject', 'body'}, [href[:120], q.get('subject')])
    close(pg)

    # ------------------------------------------------------------ 5. email only (no URL): nothing is sent by the widget at all
    RECEIVED.clear(); reqs.clear()
    mount(pg, dict(T, **{'data-shipping': '1', 'data-shipping-email': 'orders@merch-shop.example', 'data-lang': 'de'}))
    click(pg); wait(pg, W('shipping'))
    priv = modal(pg, "return r.querySelector('.priv').textContent")
    check('email-only: privacy note without host', priv == '\U0001F512 Deine Adresse geht nur an Merch Shop, nie an Kallubi.', priv)
    fill(pg, BUYER); submit(pg); wait(pg, W('paid'), 12000)
    m = modal(pg, "const a = r.querySelector('[data-mailto]'); return [a && a.textContent, !!r.querySelector('.shs')]")
    check('email-only: mailto button in German, no status line', m == ['Adresse per E-Mail an den Shop \u2709', False], m)
    check('email-only: no network request at all (test mode)', not reqs and not RECEIVED, [q['url'] for q in reqs])
    close(pg)

    # ------------------------------------------------------------ 6. real mode (WhatsOnChain mocked): POST after detection, WoC never sees the address
    RECEIVED.clear(); reqs.clear(); woc.phase = 'empty'
    R = {k: v for k, v in T.items() if not k.startswith('data-test')}
    mount(pg, dict(R, **{'data-shipping': '1', 'data-shipping-url': MERCH + '/orders', 'data-poll-ms': '1000'}))
    click(pg); pg.wait_for_timeout(1500)
    check('real mode: no chain polling while the form is open', not any(is_chain(q['url']) for q in reqs))
    fill(pg, BUYER); submit(pg); wait(pg, W('waiting'))
    req_sats = events(pg, 'kallubi:shipping')[0]['requestedSats']
    pg.wait_for_timeout(2500); woc.pay_sats = req_sats; woc.phase = 'mempool'
    check('real mode: paid', wait(pg, W('paid'), 20000))
    wait(pg, "window.__ev.some(e => e.type === 'kallubi:shipping-sent')", 8000)
    check('real mode: merchant got the real txid + address', len(RECEIVED) == 1 and json.loads(RECEIVED[0]['body'])['txid'] == woc.txid and json.loads(RECEIVED[0]['body'])['test'] is False, len(RECEIVED))
    check('real mode: chain sources were polled (detection works)', any(is_chain(q['url']) for q in reqs))
    close(pg)

    # ------------------------------------------------------------ 7. six languages
    pg.goto(BASE + '/tests/ship.html'); pg.wait_for_function('window.KallubiPay')
    EN = pg.evaluate("KallubiPay.util.strings('en')")
    SKEYS = ['shipH', 'shipSub', 'fName', 'fStreet', 'fZip', 'fCity', 'fCountry', 'fEmail', 'fNote', 'req', 'badEmail', 'fixErr', 'shipNoteM', 'shipNote', 'shipVia', 'toPay', 'shipTo', 'edit',
             'shipSending', 'shipSent', 'shipFail', 'shipMail', 'shipMailHint', 'shipKeep', 'mailSubj', 'mailHello', 'eShipUrl', 'eShipMail']
    check('i18n: %d shipping keys in English' % len(SKEYS), all(k in EN for k in SKEYS), [k for k in SKEYS if k not in EN])
    for lang in ['en', 'de', 'es', 'fr', 'it', 'pt']:
        mount(pg, dict(T, **{'data-shipping': '1', 'data-lang': lang}))
        click(pg); wait(pg, W('shipping'))
        S = pg.evaluate("(l) => KallubiPay.util.strings(l)", lang)
        got = modal(pg, "return { labels: Array.from(r.querySelectorAll('form label')).map(l => l.textContent), h: r.querySelector('.sh').textContent, btn: r.querySelector('form button[type=submit]').textContent, priv: r.querySelector('.priv').textContent, lang: r.querySelector('.ov').getAttribute('lang') }")
        want = [S[k] for k in ['fName', 'fStreet', 'fZip', 'fCity', 'fCountry', 'fEmail', 'fNote']]
        submit(pg); req = modal(pg, "return Array.from(r.querySelectorAll('.fe')).map(e => e.textContent).filter(Boolean)")
        check('lang %s: form labels, heading, button, privacy note, errors' % lang, got['labels'] == want and got['h'] == S['shipH'] and got['btn'] == S['toPay'] and got['lang'] == lang
              and got['priv'] == S['shipNoteM'].replace('{m}', 'Merch Shop') and req == [S['req']] * 5, got)
        if lang != 'en':
            same = [k for k in SKEYS if k not in S or S[k] == EN[k]]
            check('lang %s: all %d shipping strings present and translated' % (lang, len(SKEYS)), not same, same)
        close(pg)

    # ------------------------------------------------------------ 7b. XSS in shipping fields, merchant name, mailto
    xss_buyer = {'name': '<img src=x onerror="window.__xss=1">', 'street': '<script>window.__xss=2</script>',
                 'postalCode': '"><svg onload=window.__xss=3>', 'city': 'Exampleton', 'country': 'United Kingdom',
                 'email': '', 'note': '<b onmouseover=window.__xss=4>x</b>'}
    pg.evaluate("window.__xss = 0")
    mount(pg, dict(T, **{'data-shipping': '1', 'data-shipping-email': 'orders@merch-shop.example',
                         'data-merchant': '<script>window.__xss=5</script>', 'data-label': '<img src=x onerror="window.__xss=6">',
                         'data-test-delay': '800'}))
    click(pg); wait(pg, W('shipping'))
    fill(pg, xss_buyer); submit(pg); wait(pg, W('waiting'))
    xsum = modal(pg, "return { scripts: r.querySelectorAll('script,img,svg[onload],b').length, text: r.querySelector('.mbody').innerText, title: r.querySelector('.mhead .t').textContent, sub: r.querySelector('.mhead .s').textContent }")
    check('XSS: shipping / merchant / label payloads rendered as text in QR step', pg.evaluate('window.__xss') == 0 and xsum['scripts'] == 0 and '<img src=x' in xsum['text'] and '<script>' in xsum['title'], xsum)
    evs = events(pg, 'kallubi:shipping')
    check('XSS: shipping event carries the raw text (not executed)', evs and evs[-1]['shipping']['name'] == xss_buyer['name'] and evs[-1]['shipping']['street'] == xss_buyer['street'], evs[-1]['shipping'] if evs else None)
    wait(pg, W('paid'), 12000)
    href = modal(pg, "const a = r.querySelector('a[data-mailto]'); return a && a.getAttribute('href');")
    check('XSS: mailto href is encodeURIComponent-safe (no raw tags, no javascript:)', bool(href) and href.startswith('mailto:orders@merch-shop.example?') and '<' not in href and 'javascript:' not in href.lower() and '%3Cimg' in href, (href or '')[:200])
    paid_dom = modal(pg, "return { scripts: r.querySelectorAll('script,img,svg[onload]').length, html: r.querySelector('.mbody').innerHTML }")
    check('XSS: paid view has no injected nodes', pg.evaluate('window.__xss') == 0 and paid_dom['scripts'] == 0 and '<img' not in paid_dom['html'] and '<script' not in paid_dom['html'], paid_dom['scripts'])
    close(pg)
    # no script tags added to the host page either
    check('XSS: host page gained no extra script elements', pg.evaluate("document.scripts.length") <= 2)

    # ------------------------------------------------------------ 8. themes, mobile, focus trap
    for theme, want in (('dark', '#f8fafc'), ('light', '#14141c')):
        mount(pg, dict(T, **{'data-shipping': '1', 'data-theme': theme})); click(pg); wait(pg, W('shipping'))
        c = modal(pg, "const ov = r.querySelector('.ov'), i = r.querySelector('.in'); return [getComputedStyle(ov).getPropertyValue('--tx').trim(), getComputedStyle(i).color, getComputedStyle(i).backgroundColor, getComputedStyle(i).borderTopLeftRadius]")
        check('theme %s: form colours' % theme, c[0] == want and c[3] == '10px', c)
        close(pg)
    mount(pg, dict(T, **{'data-shipping': '1'})); click(pg); wait(pg, W('shipping'))
    order = []
    for _ in range(12):
        pg.keyboard.press('Tab'); order.append(modal(pg, "const a = r.activeElement; return a ? (a.name || a.className.split(' ')[0]) : null"))
    check('focus trap: Tab cycles through the fields and stays in the dialog', 'name' in order and 'note' in order and 'btn' in order and None not in order, order)
    pg.keyboard.press('Escape')
    check('Escape closes the form', not pg.evaluate("document.querySelectorAll('[data-kallubi-modal]').length"))
    mctx = b.new_context(viewport={'width': 375, 'height': 740}, is_mobile=True, has_touch=True, device_scale_factor=2)
    mp = mctx.new_page(); woc.route_all(mp)
    mp.goto(BASE + '/tests/ship.html'); mp.wait_for_function('window.KallubiPay')
    mount(mp, dict(T, **{'data-shipping': '1'})); click(mp); wait(mp, W('shipping'))
    mm = modal(mp, "const d = r.querySelector('.modal').getBoundingClientRect(), i = r.querySelector('.in'); const two = r.querySelector('.two').getBoundingClientRect(); return [d.left, d.right, innerWidth, getComputedStyle(i).fontSize, r.querySelector('.modal').scrollWidth <= r.querySelector('.modal').clientWidth, two.right <= d.right]")
    check('mobile 375px: dialog fits, no horizontal scroll, 16px inputs (no iOS zoom)', mm[0] >= 0 and mm[1] <= mm[2] and mm[3] == '16px' and mm[4] and mm[5], mm)
    mp.screenshot(path='/tmp/ship-mobile.png')
    mctx.close()

    # ------------------------------------------------------------ 9. strict CSP page (style-src 'none') renders the form
    cp = ctx.new_page(); csp = []
    cp.on('console', lambda m: ('Content Security Policy' in m.text or 'Refused' in m.text) and csp.append(m.text))
    cp.goto(BASE + '/tests/csp.html'); cp.wait_for_function("document.querySelector('#b .kallubi-pay-host')")
    cp.evaluate("""() => { const d = document.createElement('div'); d.setAttribute('data-kallubi-pay', ''); d.id = 'w';
      for (const [k, v] of Object.entries({'data-to': '1111111111111111111114oLvT2', 'data-amount': '0.0005', 'data-test': '1', 'data-shipping': '1', 'data-theme': 'dark'})) d.setAttribute(k, v);
      document.body.appendChild(d); }""")
    cp.wait_for_function("document.querySelector('#w .kallubi-pay-host')"); click(cp); wait(cp, W('shipping'))
    br = modal(cp, "return getComputedStyle(r.querySelector('.in')).borderTopLeftRadius")
    check('strict CSP: form styled, no CSP violations', br == '10px' and not csp, [br, csp])
    cp.close()

    # ------------------------------------------------------------ privacy over all recorded requests (sections 5-9; 3/4 checked via RECEIVED)
    leaks = [q for q in reqs if any(mk in (q['url'] + q['post']) for mk in MARKERS)]
    bad = [q['url'].split('?')[0] for q in leaks if not q['url'].startswith(MERCH + '/')]
    check('privacy: the address never goes to any host other than the merchant URL', not bad, bad)
    check('privacy: no chain request carries address data', not any(is_chain(q['url']) and any(mk in q['url'] + q['post'] for mk in MARKERS) for q in reqs))
    st = pg.evaluate("[localStorage.length, sessionStorage.length, document.cookie]")
    check('privacy: nothing in localStorage / sessionStorage / cookies', st == [0, 0, ''], st)
    check('no JS errors', not errors, errors)

    if not SKIP_SHOTS:
            # ------------------------------------------------------------ screenshots (own, clean: test mode, demo address, fictional buyer)
            def shot_form(theme, lang, fn, filled):
                sc = b.new_context(viewport={'width': 560, 'height': 1060}, device_scale_factor=2, color_scheme=theme); sp = sc.new_page()
                sp.goto(BASE + '/tests/ship.html'); sp.wait_for_function('window.KallubiPay')
                sp.evaluate("(t) => { document.body.style.margin = '0'; document.body.style.background = t === 'dark' ? '#0b0b10' : '#f4f1ea'; }", theme)
                mount(sp, {'data-to': ADDR, 'data-amount': '0.0005', 'data-label': 'Gold Logo Hoodie', 'data-merchant': 'Merch Shop',
                           'data-order': 'MS-7', 'data-test': '1', 'data-test-delay': '600000', 'data-theme': theme, 'data-lang': lang, 'data-shipping': '1',
                           'data-shipping-url': 'https://merch-shop.example/api/orders'})
                click(sp); wait(sp, W('shipping'))
                if filled: fill(sp, filled)
                sp.wait_for_timeout(400); sp.screenshot(path=SHOTS + fn); sc.close()
            shot_form('dark', 'en', 'shipping-en-dark-form.png', {'name': 'Alex Example', 'street': '42 Sample Street', 'postalCode': 'AB1 2CD', 'city': 'Exampleton', 'country': 'United Kingdom'})
            shot_form('light', 'de', 'shipping-de-light-form.png', {'name': 'Erika Mustermann', 'street': 'Musterweg 12', 'postalCode': '12345', 'city': 'Musterstadt', 'country': 'Deutschland'})
            sc = b.new_context(viewport={'width': 560, 'height': 1000}, device_scale_factor=2); sp = sc.new_page()
            sp.goto(BASE + '/tests/ship.html'); sp.wait_for_function('window.KallubiPay'); sp.evaluate("document.body.style.background = '#0b0b10'")
            mount(sp, dict(T, **{'data-shipping': '1', 'data-shipping-url': MERCH + '/orders'}))
            click(sp); wait(sp, W('shipping')); fill(sp, {'name': 'Alex Example', 'street': '42 Sample Street', 'postalCode': 'AB1 2CD', 'city': 'Exampleton', 'country': 'United Kingdom'})
            submit(sp); wait(sp, W('paid'), 12000); wait(sp, "window.__ev.some(e => e.type === 'kallubi:shipping-sent')", 8000); sp.wait_for_timeout(400)
            sp.screenshot(path=SHOTS + 'shipping-en-dark-paid.png'); sc.close()
    b.close()
srv.shutdown()
json.dump(results, open(os.path.join(HERE, 'results-shipping.json'), 'w'), indent=1)
f = [r for r in results if not r['ok']]
print(json.dumps({'passed': len(results) - len(f), 'failed': len(f)}))
sys.exit(1 if f else 0)
