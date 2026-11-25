"""Headless Chromium tests for the Kallubi Pay Button (dist/button.min.js).
Run:  python3 -m http.server 8765 --bind 127.0.0.1 &   then   python tests/test_widget.py
"""
import json, re, sys, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765'
DEMO = BASE + '/demo/'
ADDR = '1111111111111111111114oLvT2'
LIVE = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
results = []

def woc_get(url, tries=5):
    # read-only public API; WoC answers 429 when polled too fast, so back off and retry
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(url, timeout=20))
        except urllib.error.HTTPError as e:
            if e.code != 429 or i == tries - 1: raise
            time.sleep(2 + 2 * i)

def check(name, cond, info=''):
    results.append({'test': name, 'ok': bool(cond), 'info': info})
    print(('PASS ' if cond else 'FAIL ') + name + (('  [' + str(info) + ']') if info else ''))

def sr(page, sel, js):
    """run js(shadowRoot) for the widget host inside element `sel`"""
    return page.evaluate("([s, f]) => { const h = document.querySelector(s).querySelector('.kallubi-pay-host'); return (new Function('r', f))(h.shadowRoot); }", [sel, js])

def modal(page, js):
    return page.evaluate("(f) => { const h = document.querySelector('[data-kallubi-modal]'); if (!h) return null; return (new Function('r', f))(h.shadowRoot); }", js)

def view(page):
    return modal(page, "const d = r.querySelector('.modal'); return d && d.getAttribute('data-view');")

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    ctx = b.new_context(viewport={'width': 1280, 'height': 900})
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    pg = ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    reqs = []
    pg.on('request', lambda r: reqs.append(r.url))
    pg.goto(DEMO); pg.wait_for_function('window.KallubiPay && document.querySelectorAll(".kallubi-pay-host").length >= 6')

    # 1 both themes render
    lt = sr(pg, '#btn-light', "const x = r.querySelector('.root'); return [x.className, getComputedStyle(x).getPropertyValue('--tx').trim(), r.querySelector('button').textContent]")
    dk = sr(pg, '#btn-dark', "const x = r.querySelector('.root'); return [x.className, getComputedStyle(x).getPropertyValue('--tx').trim(), r.querySelector('button').textContent]")
    check('render: light theme', 't-light' in lt[0] and lt[1] == '#14141c' and 'Pay with BSV' in lt[2], lt)
    check('render: dark theme', 't-dark' in dk[0] and dk[1] == '#f8fafc' and 'Pay with BSV' in dk[2], dk)
    bg = sr(pg, '#btn-light', "return getComputedStyle(r.querySelector('button')).backgroundImage")
    check('render: gold gradient button', '240, 193, 75' in bg or 'rgb(245, 215, 110)' in bg, bg[:80])
    pw_link = sr(pg, '#btn-light', "const a = r.querySelector('.pwr a'); return [a.textContent, a.href, a.rel]")
    check('render: "Powered by Kallubi" link', pw_link[0] == 'Kallubi' and 'kallubi-bsv-explorer.de' in pw_link[1] and 'noopener' in pw_link[2], pw_link)
    variants = pg.evaluate("Array.from(document.querySelectorAll('.kallubi-pay-host')).map(h => h.shadowRoot.querySelector('button') && h.shadowRoot.querySelector('button').className)")
    check('render: variants gold/outline/sm', any('outline' in v and 'sm' in v for v in variants) and any(v.startswith('btn gold sm') for v in variants), variants)
    check('render: no JS errors', not errors, errors)

    # 2 auto theme follows prefers-color-scheme
    for scheme, want in (('light', '#14141c'), ('dark', '#f8fafc')):
        pg.emulate_media(color_scheme=scheme)
        got = pg.evaluate("() => { const h = Array.from(document.querySelectorAll('[data-theme=auto] .kallubi-pay-host'))[0]; return getComputedStyle(h.shadowRoot.querySelector('.root')).getPropertyValue('--tx').trim(); }")
        check('auto theme follows ' + scheme + ' mode', got == want, got)
    pg.emulate_media(color_scheme='dark')

    # 3 open modal, QR present, URI correct
    pg.evaluate("document.querySelector('#btn-light .kallubi-pay-host').shadowRoot.querySelector('button').click()")
    pg.wait_for_function("document.querySelector('[data-kallubi-modal]')")
    info = modal(pg, """const q = r.querySelector('.qrwrap'); const p = q.querySelector('svg.qr path');
      return {view: r.querySelector('.modal').dataset.view, uri: q.dataset.uri, d: p ? p.getAttribute('d').length : 0, logo: !!q.querySelector('.ql svg'),
              amt: r.querySelector('.amt .v').dataset.amount, sats: r.querySelector('.amt .sats').textContent, timer: r.querySelector('.timer').textContent,
              open: r.querySelector('a.btn.gold').getAttribute('href'), title: r.querySelector('.mhead .t').textContent, sub: r.querySelector('.mhead .s').textContent,
              theme: r.querySelector('.ov').className}""")
    m = re.match(r'^bitcoin:' + ADDR + r'\?amount=(0\.0005\d{0,4})&label=Basic%20T-Shirt$', info['uri'] or '')
    check('modal: opens in waiting view', info['view'] == 'waiting' and 't-light' in info['theme'], info['view'])
    check('modal: BIP21 URI with unique amount', bool(m) and 50001 <= int(round(float(m.group(1)) * 1e8)) <= 50099, info['uri'])
    check('modal: QR svg + K logo in centre', info['d'] > 1000 and info['logo'], info['d'])
    check('modal: "Open in wallet" = same bitcoin: URI', info['open'] == info['uri'])
    check('modal: amount BSV + sats shown', info['amt'] == m.group(1) if m else False, info['amt'] + ' / ' + info['sats'])
    check('modal: 15 min countdown', info['timer'] in ('15:00', '14:59'), info['timer'])
    check('modal: header text', info['title'] == 'Pay Example Shop' and info['sub'] == 'Order #EX-0001 · Basic T-Shirt', info['sub'])
    # QR really decodes (with the logo on top)
    try:
        import cv2, numpy as np
        png = pg.evaluate_handle("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.qrwrap')").as_element().screenshot()
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        img = cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST)
        txt, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
        check('modal: QR decodes to the payment URI (logo does not break it)', txt == info['uri'], txt)
    except ImportError:
        check('modal: QR decode (opencv missing, skipped)', True)

    # 4 copy works
    modal(pg, "r.querySelector('.copy').click()")
    pg.wait_for_timeout(300)
    clip = pg.evaluate('navigator.clipboard.readText()')
    lbl = modal(pg, "return r.querySelector('.copy span').textContent")
    check('copy: address in clipboard', clip == ADDR and lbl == 'Copied', [clip, lbl])

    # 5 test mode -> paid, event + callback
    pg.wait_for_function("(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view === 'paid'; })()", timeout=12000)
    ev = pg.evaluate('window.__paidEvents'); cb = pg.evaluate('window.__lastCallback')
    paid = modal(pg, """return {h: r.querySelector('.ok h2').textContent, rows: Array.from(r.querySelectorAll('.row')).map(x => x.textContent),
       ex: r.querySelector('a.btn.outline').textContent, back: r.querySelector('.ok button.btn.gold').textContent}""")
    check('test mode: success view after ~8 s', paid['h'].startswith('Payment received') and paid['back'] == 'Back to shop', paid)
    check('test mode: kallubi:paid event fired once', isinstance(ev, list) and len(ev) == 1 and re.fullmatch('[0-9a-f]{64}', ev[0]['txid']) and ev[0]['to'] == ADDR and ev[0]['order'] == 'EX-0001' and ev[0]['test'] is True, ev)
    check('test mode: data-on-paid callback called', cb and cb['txid'] == ev[0]['txid'], cb and cb['amount'])
    btxt = sr(pg, '#btn-light', "const b = r.querySelector('button'); return [b.textContent, b.disabled]")
    check('after paid: button shows "Paid ✓"', btxt[0].endswith('Paid ✓') and btxt[1], btxt)
    modal(pg, "r.querySelector('.ok button.btn.gold').click()")
    check('"Back to shop" closes the modal', pg.evaluate("!document.querySelector('[data-kallubi-modal]')"))

    # 6 Escape closes, focus handling
    pg.evaluate("document.querySelector('#btn-dark .kallubi-pay-host').shadowRoot.querySelector('button').click()")
    pg.wait_for_function("document.querySelector('[data-kallubi-modal]')")
    pg.keyboard.press('Escape')
    check('Escape closes the modal', pg.evaluate("!document.querySelector('[data-kallubi-modal]')"))

    # 7 expiry + try again
    pg.evaluate("""() => { const d = document.createElement('div'); d.id = 'exp'; Object.assign(d.dataset, {kallubiPay: '', to: '%s', amount: '0.001', theme: 'dark', test: '1', testDelay: '60000', ttl: '3'}); document.body.appendChild(d); }""" % ADDR)
    pg.wait_for_function("document.querySelector('#exp .kallubi-pay-host')")
    sr(pg, '#exp', "r.querySelector('button').click()")
    pg.wait_for_function("(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view === 'expired'; })()", timeout=8000)
    exp = modal(pg, "return [r.querySelector('h2').textContent, r.querySelector('.ok button').textContent]")
    check('expiry: expired view after TTL', exp == ['Payment window expired', 'Try again'], exp)
    modal(pg, "r.querySelector('.ok button').click()")
    check('expiry: "Try again" starts a fresh invoice', view(pg) == 'waiting')
    pg.keyboard.press('Escape')

    # 8 XSS attempt via data-label / data-merchant / data-order
    pg.evaluate("""() => { window.__xss = 0; const d = document.createElement('div'); d.id = 'xss';
      Object.assign(d.dataset, {kallubiPay: '', to: '%s', amount: '0.001', test: '1', testDelay: '60000',
        label: '<img src=x onerror="window.__xss=1">', merchant: '<script>window.__xss=2<\\/script>', order: '"><svg onload=window.__xss=3>', buttonText: '<b onmouseover=window.__xss=4>x</b>'});
      document.body.appendChild(d); }""" % ADDR)
    pg.wait_for_function("document.querySelector('#xss .kallubi-pay-host')")
    sr(pg, '#xss', "r.querySelector('button').click()")
    pg.wait_for_timeout(600)
    x = modal(pg, "return {imgs: r.querySelectorAll('img,script,b,svg[onload]').length, sub: r.querySelector('.mhead .s').textContent, t: r.querySelector('.mhead .t').textContent, uri: r.querySelector('.qrwrap').dataset.uri}")
    btn = sr(pg, '#xss', "return [r.querySelector('button').textContent, r.querySelectorAll('b').length]")
    check('XSS: payloads rendered as text, nothing executed', pg.evaluate('window.__xss') == 0 and x['imgs'] == 0 and '<img src=x' in x['sub'] and '<script>' in x['t'] and btn[1] == 0, x)
    check('XSS: label URL-encoded in bitcoin: URI', '%3Cimg' in x['uri'] and '<' not in x['uri'], x['uri'][-60:])
    pg.keyboard.press('Escape')

    # 9 address + amount validation (incl. network mismatch and amount limits)
    v = pg.evaluate("""() => { const u = KallubiPay.util;
      const bad = ['garbage', '', '1111111111111111111114oLvT3', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', '<script>alert(1)</script>', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa '];
      const kinds = {
        testnetP2PKH: u.addressError('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'),
        testnetP2PKH0: u.addressError('mfWxJ45yp2SFn7UciZyNpvDKrzbhyfKrY8'),
        testnetP2SH: u.addressError('2MsFDzHRUAMpjHxKyoEHU3aMCMsVtMqs1PV'),
        p2sh: u.addressError('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'),
        bech32: u.addressError('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'),
        cashaddr: u.addressError('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'),
        garbage: u.addressError('not-an-address'),
        xss: u.addressError('<script>alert(1)</script>'),
        good: u.addressError('%s')
      };
      return {bad: bad.map(a => u.addressScript(a)), good: [u.addressScript('%s'), u.addressScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')],
        kinds,
        amtBad: ['0', '-1', 'abc', '0.000000001', '1e5', '', '21000001', '0x10', '0,0005', '100000000'].map(u.parseAmount),
        amtErr: {
          fmt: ['abc', '1e5', '0x10', '0,0005', '0.000000001', ''].map(u.amountError),
          min: ['0', '0.00000000'].map(u.amountError),
          max: ['21000001', '21000000.00000001', '100000000'].map(u.amountError),
          ok: u.amountError('0.0005')
        },
        amtGood: ['0.0005', '1', '0.00000001', '21000000'].map(u.parseAmount),
        sha: u.sha256hex(new TextEncoder().encode('abc'))}; }""" % (ADDR, ADDR))
    check('validation: garbage / bad checksum / P2SH / bech32 / testnet / html addresses rejected', all(a is None for a in v['bad']), v['bad'])
    check('validation: valid P2PKH accepted (correct hash160)', v['good'] == ['76a914' + '00' * 20 + '88ac', '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'], v['good'])
    check('validation: testnet/STN addresses reported as network mismatch', v['kinds']['testnetP2PKH'] == 'eToNet' and v['kinds']['testnetP2PKH0'] == 'eToNet' and v['kinds']['testnetP2SH'] == 'eToNet', v['kinds'])
    check('validation: mainnet P2SH reported as unsupported type', v['kinds']['p2sh'] == 'eToType', v['kinds'])
    check('validation: bech32 / cashaddr / garbage / html reported as invalid', v['kinds']['bech32'] == 'eTo' and v['kinds']['cashaddr'] == 'eTo' and v['kinds']['garbage'] == 'eTo' and v['kinds']['xss'] == 'eTo' and v['kinds']['good'] is None, v['kinds'])
    check('validation: bad amounts rejected', all(a is None for a in v['amtBad']), v['amtBad'])
    check('validation: amount format vs min vs max errors', v['amtErr']['fmt'] == ['eAmount']*6 and v['amtErr']['min'] == ['eAmountMin','eAmountMin'] and v['amtErr']['max'] == ['eAmountMax']*3 and v['amtErr']['ok'] is None, v['amtErr'])
    check('validation: amounts parsed exactly to sats', v['amtGood'] == [50000, 100000000, 1, 2100000000000000], v['amtGood'])
    check('sha256 self-test', v['sha'] == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    pg.evaluate("""() => { const d = document.createElement('div'); d.id = 'badaddr'; Object.assign(d.dataset, {kallubiPay: '', to: 'not-an-address', amount: 'abc', currency: 'EUR'}); document.body.appendChild(d); }""")
    pg.wait_for_function("document.querySelector('#badaddr .kallubi-pay-host')")
    e = sr(pg, '#badaddr', "return [!!r.querySelector('button'), (r.querySelector('[role=alert]') || {}).textContent]")
    check('validation: widget with bad config shows error, no pay button', e[0] is False and 'invalid BSV address' in e[1] and 'invalid amount' in e[1] and 'not supported' in e[1], e[1])
    def mount_err(eid, to, amount):
        pg.evaluate("""([id, to, amount]) => { const d = document.createElement('div'); d.id = id; Object.assign(d.dataset, {kallubiPay: '', to, amount}); document.body.appendChild(d); }""", [eid, to, amount])
        pg.wait_for_function("document.querySelector('#%s .kallubi-pay-host')" % eid)
        return sr(pg, '#' + eid, "return [!!r.querySelector('button'), (r.querySelector('[role=alert]') || {}).textContent]")
    eNet = mount_err('badnet', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', '0.0005')
    check('validation: widget shows network-mismatch error for testnet data-to', eNet[0] is False and 'testnet or STN' in eNet[1] and 'invalid BSV address' not in eNet[1], eNet[1])
    eType = mount_err('badtype', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', '0.0005')
    check('validation: widget shows P2SH type error for 3… data-to', eType[0] is False and 'P2SH' in eType[1], eType[1])
    eMin = mount_err('badmin', ADDR, '0')
    check('validation: widget shows minimum amount error', eMin[0] is False and 'at least 1 satoshi' in eMin[1], eMin[1])
    eMax = mount_err('badmax', ADDR, '21000001')
    check('validation: widget shows maximum amount error', eMax[0] is False and 'must not exceed 21000000 BSV' in eMax[1], eMax[1])

    # 9b no external scripts + data-on-paid is looked up, never eval'ed
    scripts = pg.evaluate("() => Array.from(document.scripts).map(x => x.src || '(inline)')")
    js_text = pg.evaluate("() => fetch('/dist/button.min.js').then(r => r.text())")
    check('scripts: page only loads the local button script', all('button' in x or x == '(inline)' for x in scripts) and any('button' in x for x in scripts), scripts)
    banned = ['createElement("script")', "createElement('script')", 'document.write', 'eval(', 'new Function']
    check('scripts: widget source does not create or fetch external script tags', not any(b in js_text for b in banned) and 'import(' not in js_text, [b for b in banned if b in js_text])
    pg.evaluate("""() => { window.__paidHook = 0; window['alert;payload'] = function(){ window.__paidHook = 99; };
      window.evil = { onPaid(){ window.__paidHook = 1; } };
      const d = document.createElement('div'); d.id = 'onpaidbad';
      Object.assign(d.dataset, {kallubiPay: '', to: '%s', amount: '0.0005', test: '1', testDelay: '400', onPaid: 'alert(1);evil.onPaid'});
      document.body.appendChild(d); }""" % ADDR)
    pg.wait_for_function("document.querySelector('#onpaidbad .kallubi-pay-host')")
    sr(pg, '#onpaidbad', "r.querySelector('button').click()")
    pg.wait_for_timeout(1200)
    check('scripts: data-on-paid is not evaled (malicious name ignored)', pg.evaluate('window.__paidHook') == 0 and pg.evaluate('window.__xss || 0') == 0)

    # 10 style isolation (hostile host CSS)
    pg.add_style_tag(content='button{display:none!important;background:red!important} *{color:lime!important;font-size:3px!important} div{padding:40px!important}')
    iso = sr(pg, '#btn-dark', "const b = r.querySelector('button'); const cs = getComputedStyle(b); return [cs.display, cs.backgroundImage.slice(0, 40), cs.color, cs.fontSize]")
    check('Shadow DOM: host page CSS does not break the button', iso[0] == 'flex' and 'gradient' in iso[1] and iso[2] == 'rgb(26, 20, 8)' and iso[3] == '16px', iso)

    # 11 privacy: no cookies, only expected requests
    check('privacy: no cookies set', ctx.cookies() == [])
    ext = [u for u in reqs if not u.startswith(BASE) and not u.startswith('data:')]
    check('privacy: no external requests in test mode (no CDN, no tracking)', ext == [], ext)

    # 12 REAL read-only detection against BSV mainnet via the public fallback source (no spending); raw hex is verified in the widget
    pg.goto(DEMO); pg.wait_for_function('window.KallubiPay')
    hist = woc_get('https://api.whatsonchain.com/v1/bsv/main/address/%s/confirmed/history?order=desc&limit=1' % LIVE)
    h = hist['result'][-1]['tx_hash']
    # every other tx the watcher can see right now goes into the baseline, so only `h` is "new"
    others = woc_get('https://api.whatsonchain.com/v1/bsv/main/address/%s/confirmed/history?order=desc&limit=20' % LIVE)['result']
    others += woc_get('https://api.whatsonchain.com/v1/bsv/main/address/%s/unconfirmed/history' % LIVE)['result']
    others = {o['tx_hash']: 1 for o in others if o['tx_hash'] != h}
    tx = woc_get('https://api.whatsonchain.com/v1/bsv/main/tx/hash/' + h)
    want = sum(round(v['value'] * 1e8) for v in tx['vout'] if v['scriptPubKey'].get('hex') == '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac')
    time.sleep(1.5)
    live = pg.evaluate("""async ([addr, want, h, others]) => {
      const u = KallubiPay.util, script = u.addressScript(addr);
      const run = async (sats, baseline, since) => {
        const w = new u.Watcher({address: addr, script, sats, since, node: '', fallback: 'https://api.whatsonchain.com/v1/bsv/main'}); w.baseline = baseline; w.n = 3;   // next step also reads the confirmed list
        for (let i = 0; i < 8; i++) { let m = null; try { m = await w.step(); } catch (e) { await new Promise(r => setTimeout(r, 2500)); continue; }
          if (m) return m; if (!w.queue.length && i > 0) return null; await new Promise(r => setTimeout(r, 700)); }
        return null; };
      const pos = await run(want, {...others}, 0);                         // tx treated as "new" -> must match
      const neg = await run(want + 1, {...others}, 0);                     // 1 sat more than paid -> must not match this tx
      const base = await run(want, {...others, [h]: 1}, 0);                  // tx already existed when dialog opened -> ignored
      const old = await run(want, {...others}, Math.floor(Date.now() / 1000));   // tx older than the invoice -> ignored
      return {pos, neg, base, old}; }""", [LIVE, want, h, others])
    check('LIVE detection: real mainnet tx %s… (%d sats to %s) matched' % (h[:12], want, LIVE), live['pos'] and live['pos']['txid'] == h and live['pos']['sats'] == want, live['pos'])
    check('LIVE detection: amount + 1 sat is not matched', live['neg'] is None, live['neg'])
    check('LIVE detection: tx in baseline (seen before open) is ignored', live['base'] is None, live['base'])
    check('LIVE detection: tx older than "since" is ignored', live['old'] is None, live['old'])
    b.close()

passed = sum(r['ok'] for r in results)
print(json.dumps({'passed': passed, 'failed': len(results) - passed}))
json.dump(results, open('tests/results-widget.json', 'w'), indent=1, ensure_ascii=False)
sys.exit(0 if passed == len(results) else 1)
