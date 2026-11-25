"""v1.2.0 tests: fiat pricing (data-amount-fiat), EUR backup rate (WhatsOnChain USD x ECB), confirmation policy (0-conf up to 20.00),
order reference (data-order-id), expiry (data-expires-min) + late payments,
backward compatibility with the v1.0.0 build, strict CSP. All exchange-rate and chain calls are mocked (no real money, no live APIs).
Run:  python3 -m http.server 8765 --bind 127.0.0.1 &   then   python3 tests/test_v120.py"""
import json, re, sys, time, math, datetime
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765'
ADDR = '1111111111111111111114oLvT2'
results = []
def check(name, cond, info=''):
    results.append({'test': name, 'ok': bool(cond), 'info': info if not cond else ''})
    print(('PASS ' if cond else 'FAIL ') + name + (('  [' + str(info)[:400] + ']') if (info != '' and not cond) else ''))

M = "(f) => { const h = document.querySelector('[data-kallubi-modal]'); return h ? (new Function('r', f))(h.shadowRoot) : null; }"
def modal(pg, js): return pg.evaluate(M, js)
def view(pg): return modal(pg, "const d = r.querySelector('.modal'); return d && d.dataset.view;")
def wait(pg, js, ms=15000):
    try: pg.wait_for_function(js, timeout=ms); return True
    except Exception: return False
def W(v): return "(() => { const h = document.querySelector('[data-kallubi-modal]'); return !!h && h.shadowRoot.querySelector('.modal').dataset.view === '%s'; })()" % v
def mount(pg, attrs):
    pg.evaluate("""(a) => { const s = document.getElementById('slot'); s.textContent = ''; const d = document.createElement('div');
      d.setAttribute('data-kallubi-pay', ''); d.id = 'w'; for (const k in a) d.setAttribute(k, a[k]); s.appendChild(d); window.__ev = []; }""", attrs)
    pg.wait_for_function("document.querySelector('#w .kallubi-pay-host')")
def btn_text(pg): return pg.evaluate("(() => { const r = document.querySelector('#w .kallubi-pay-host').shadowRoot; const b = r.querySelector('button'); return b ? b.textContent.replace('\u20bf', '') : r.textContent; })()")
def click(pg): pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').click()")
def close(pg):
    for _ in range(3):
        if not pg.evaluate("document.querySelectorAll('[data-kallubi-modal]').length"): break
        pg.keyboard.press('Escape'); pg.wait_for_timeout(120)
def events(pg, t): return pg.evaluate("(t) => window.__ev.filter(e => e.type === t).map(e => e.d)", t)
def err_text(pg): return pg.evaluate("(() => { const e = document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('.err'); return e ? e.textContent : null; })()")
SNAP = r"""(r) => { const out = []; const w = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { if (n.nodeType === 3) { const v = n.nodeValue.trim(); if (v && !n.parentElement.closest('style')) out.push('#' + v.replace(/[0-9a-f]{64}/g, 'TX').replace(/[0-9a-f]{4,}…[0-9a-f]{4,}/g, 'TXS').replace(/\d+/g, '9')); }
    else if (n.namespaceURI !== 'http://www.w3.org/2000/svg' || n.tagName === 'svg') { if (n.tagName === 'STYLE') continue;
      const at = Array.from(n.attributes).filter(a => !/^(d|data-uri|data-amount|data-txid|title|href|style|id|aria-labelledby|for|aria-describedby)$/.test(a.name)).map(a => a.name + '=' + a.value.replace(/\d+/g, '9')).sort().join(' ');
      out.push('<' + n.tagName.toLowerCase() + ' ' + at + '>'); } }
  return out.join('\n'); }"""
def snap_btn(pg): return pg.evaluate("(f) => (eval(f))(document.querySelector('#w .kallubi-pay-host').shadowRoot)", SNAP)
def snap_modal(pg): return pg.evaluate("(f) => { const h = document.querySelector('[data-kallubi-modal]'); return h ? (eval(f))(h.shadowRoot) : null; }", SNAP)

class Net:
    """mocked CoinGecko + WhatsOnChain + ECB Data Portal"""
    def __init__(self): self.cg = 'ok'; self.woc = 'ok'; self.ecb = 'ok'; self.eur = 12.67; self.usd = 13.9; self.calls = []; self.hdrs = []
    def ecb_route(self, route):
        self.calls.append(route.request.url); self.hdrs.append(route.request.headers)
        if self.ecb == 'down': return route.fulfill(status=503, body='')
        today = datetime.datetime.now(datetime.timezone.utc).date()
        d = {'ok': today, 'old5': today - datetime.timedelta(days=5), 'stale': today - datetime.timedelta(days=6), 'future': today + datetime.timedelta(days=1)}.get(self.ecb, today)
        v = {'implausible': '3.5', 'garbage': '<b>1</b>'}.get(self.ecb, '1.0963')
        head = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE_COMPL,UNIT'
        row = 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,%s,%s,A,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD' % (d.isoformat(), v)
        if self.ecb == 'html': return route.fulfill(status=200, body='<html>maintenance</html>', headers={'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*'})
        if self.ecb == 'jpy': row = row.replace(',USD,EUR,', ',JPY,EUR,')
        route.fulfill(status=200, body=head + '\n' + row + '\n', headers={'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': '*'})
    def cg_route(self, route):
        self.calls.append(route.request.url); self.hdrs.append(route.request.headers)
        now = int(time.time())
        if self.cg == 'down': return route.fulfill(status=503, body='')
        o = {'usd': self.usd, 'eur': self.eur, 'last_updated_at': now - 30}
        if self.cg == 'stale': o['last_updated_at'] = now - 700
        if self.cg == 'future': o['last_updated_at'] = now + 900
        if self.cg == 'zero': o['eur'] = 0; o['usd'] = 0
        if self.cg == 'garbage': o['eur'] = '1e3'; o['usd'] = '<b>9</b>'
        if self.cg == 'nan': o['eur'] = None; o['usd'] = -5
        if self.cg == 'notime': del o['last_updated_at']
        route.fulfill(status=200, body=json.dumps({'bitcoin-cash-sv': o}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
    def woc_route(self, route):
        u = route.request.url; self.calls.append(u); self.hdrs.append(route.request.headers)
        if u.endswith('/exchangerate'):
            if self.woc == 'down': return route.fulfill(status=503, body='')
            t = int(time.time()) - (700 if self.woc == 'stale' else 10)
            return route.fulfill(status=200, body=json.dumps({'rate': 14.25, 'time': t, 'currency': 'USD'}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
        body = {'result': []} if 'history' in u else None
        if body is None: return route.fulfill(status=404, body='', headers={'Access-Control-Allow-Origin': '*'})
        route.fulfill(status=200, body=json.dumps(body), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})

FIAT = {'data-to': ADDR, 'data-amount-fiat': '25.00', 'data-currency': 'EUR', 'data-test': '1', 'data-test-delay': '60000', 'data-unique': '0'}

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    ctx = b.new_context(viewport={'width': 1100, 'height': 900})
    net = Net()
    ctx.route('https://api.coingecko.com/**', net.cg_route)
    ctx.route('https://api.whatsonchain.com/**', net.woc_route)
    ctx.route('https://data-api.ecb.europa.eu/**', net.ecb_route)
    pg = ctx.new_page()
    errors, dialogs = [], []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
    pg.goto(BASE + '/tests/v120.html'); pg.wait_for_function('window.KallubiPay')

    # ================================================================ 1. pure functions (fiat math, parsing)
    r = pg.evaluate("""() => { const u = KallubiPay.util; return {
      a: u.fiatToSats(2500, 12670000), b: u.fiatToSats(1, 3000000), c: u.fiatToSats(100000000, 1), d: u.fiatToSats(100, 1000000),
      e: u.fiatToSats(0, 1000000), f: u.fiatToSats(100, 0), g: u.fiatToSats(1.5, 1000000), h: u.fiatToSats(100000000, 10000000000000),
      i: u.fiatToSats(1, 10000000000000), big: u.fiatToSats(100000000, 1000000) }; }""")
    check('fiat: 25.00 EUR at 12.67 = ceil(197316495.66) = 197316496 sats (rounded up, never less than the price)', r['a'] == 197316496, r)
    check('fiat: 0.01 at rate 3 -> 333334 sats (ceil of 333333.33)', r['b'] == 333334, r)
    check('fiat: result above 21M BSV -> null (no QR)', r['c'] is None, r)
    check('fiat: exact division stays exact (1.00 at rate 1 = 100000000 sats)', r['d'] == 100000000, r)
    check('fiat: zero / fractional cents or zero rate -> null', r['e'] is None and r['f'] is None and r['g'] is None, r)
    check('fiat: 1,000,000.00 at rate 1 = 10^14 sats exactly (BigInt, no float error)', r['big'] == 100000000000000, r)
    check('fiat: tiny price at huge rate still >= 1 sat (ceil)', r['i'] == 1 and r['h'] == 10000000, r)
    pf = pg.evaluate("() => ['25', '25.5', '25.00', '0.01', '1000000.00', '1000000.01', '0', '0.00', '25,00', '25.001', '-1', '1e3', ' 7.10 ', '', '0x10', '\uff12\uff15'].map(KallubiPay.util.parseFiat)")
    check('fiat: parseFiat strict (dot, <=2 decimals, 0.01..1,000,000.00)', pf == [2500, 2550, 2500, 1, 100000000, None, None, None, None, None, None, None, 710, None, None, None], pf)
    rm = pg.evaluate("() => [12.67, '12.67', 0, -1, NaN, Infinity, '1e3', '<b>', null, 10000001, 0.0000001, 13.9].map(KallubiPay.util.rateMicro)")
    check('fiat: rateMicro rejects 0 / negative / NaN / Infinity / exponent strings / html / >10M / sub-micro', rm == [12670000, 12670000, None, None, None, None, None, None, None, None, None, 13900000], rm)
    cr = pg.evaluate("""() => { const u = KallubiPay.util, n = 1800000000; return [u.checkRate(12.5, n - 600, 'x', n) !== null, u.checkRate(12.5, n - 601, 'x', n), u.checkRate(12.5, n + 300, 'x', n) !== null,
      u.checkRate(12.5, n + 301, 'x', n), u.checkRate(12.5, 0, 'x', n), u.checkRate(12.5, 'abc', 'x', n), u.checkRate(0, n, 'x', n), u.checkRate(12.5, n + 0.5, 'x', n)]; }""")
    check('fiat: rate age boundary (600 s ok, 601 s stale; +300 s ok, +301 s refused; missing/garbage time refused)', cr == [True, None, True, None, None, None, None, None], cr)

    # ================================================================ 2. order id parsing
    oi = pg.evaluate("""() => ['ORD-2026/11#42', 'a', 'x'.repeat(64), 'x'.repeat(65), '<img src=x onerror=alert(1)>', 'A B', '"q"', 'a&b', '#1', '-1', '\u00e41', 'a\u202eb', ' MS-7 ', 'a:b.c_d'].map(KallubiPay.util.parseOrderId)""")
    check('order: parseOrderId allows letters/digits . _ - : / #, 1-64 chars, rejects html, spaces, quotes, &, unicode, RTL override',
          oi == ['ORD-2026/11#42', 'a', 'x' * 64, None, None, None, None, None, None, None, None, None, 'MS-7', 'a:b.c_d'], oi)
    g = pg.evaluate("() => { const s = new Set(); for (let i = 0; i < 2000; i++) s.add(KallubiPay.util.genRef()); return [s.size, [...s][0]]; }")
    check('order: generated refs are kp- + 20 hex (80 bit CSPRNG), 2000 draws unique', g[0] == 2000 and re.match(r'^kp-[0-9a-f]{20}$', g[1]), g)
    src = open('src/button.js', encoding='utf-8').read()
    gen_src = src[src.index('function genRef'):src.index('function genRef') + 200]
    check('order: genRef uses crypto.getRandomValues, never Math.random', 'getRandomValues' in gen_src and 'Math.random' not in src, gen_src[:120])

    # ================================================================ 3. config errors (shown as text, nothing rendered as HTML)
    cases = [({'data-amount': '0.001'}, 'eBoth', 'either data-amount'), ({'data-currency': 'GBP'}, 'eFiatCur', 'GBP'), ({'data-currency': ''}, 'eFiatCur', 'EUR or USD'),
             ({'data-amount-fiat': '25,00'}, 'eFiat', 'data-amount-fiat'), ({'data-amount-fiat': '0'}, 'eFiat', 'data-amount-fiat'), ({'data-amount-fiat': '1000000.01'}, 'eFiat', 'data-amount-fiat'),
             ({'data-expires-min': '0'}, 'eExp', 'data-expires-min'), ({'data-expires-min': '61'}, 'eExp', 'data-expires-min'), ({'data-expires-min': '1.5'}, 'eExp', 'data-expires-min'), ({'data-expires-min': 'abc'}, 'eExp', 'data-expires-min'),
             ({'data-order-id': 'x' * 65}, 'eOrder', 'data-order-id'), ({'data-order-id': 'A B'}, 'eOrder', 'data-order-id')]
    for extra, key, needle in cases:
        mount(pg, dict(FIAT, **extra)); t = err_text(pg)
        check('config error %s for %s' % (key, json.dumps(extra)[:60]), t is not None and needle in t, t)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.001', 'data-currency': 'EUR'}); t = err_text(pg)
    check('config: data-currency=EUR with data-amount -> old eCur message + hint to use data-amount-fiat', t and 'not supported in v1' in t and 'data-amount-fiat' in t, t)
    mount(pg, dict(FIAT, **{'data-lang': 'de', 'data-amount-fiat': 'abc'})); t = err_text(pg)
    check('config error in German', t and 'ungültiger Betrag in data-amount-fiat' in t, t)
    XSS = '<img src=x onerror=alert(1)>'
    mount(pg, dict(FIAT, **{'data-order-id': XSS}))
    x = pg.evaluate("() => { const r = document.querySelector('#w .kallubi-pay-host').shadowRoot; return [r.querySelectorAll('img').length, r.textContent, document.querySelectorAll('img').length]; }")
    check('order XSS: data-order-id with HTML -> config error, no <img> created, no script ran', x[0] == 0 and x[2] == 0 and 'data-order-id' in x[1] and not dialogs, x)

    # ================================================================ 4. fiat flow (EUR via CoinGecko)
    net.cg = 'ok'; net.calls.clear(); net.hdrs.clear()
    mount(pg, dict(FIAT, **{'data-order-id': 'ORD-2026/11#42', 'data-show-amount': '1', 'data-merchant': 'Merch Shop'}))
    check('fiat: button label shows the fiat price', btn_text(pg) == 'Pay €25.00', btn_text(pg))
    click(pg); ok = wait(pg, W('waiting'))
    w = modal(pg, """const a = r.querySelector('.amt .v'), q = r.querySelector('.qrwrap'); return {amt: a && a.dataset.amount, uri: q && q.dataset.uri, fiat: (r.querySelector('.fiat')||{}).textContent,
       rate: (r.querySelector('.rate')||{}).textContent, sub: r.querySelector('.mhead .s').textContent};""")
    check('fiat: waiting view shows exact BSV for 25.00 EUR at 12.67', ok and w['amt'] == '1.97316496' and w['uri'].startswith('bitcoin:' + ADDR + '?amount=1.97316496'), w)
    check('fiat: price + rate + rate time are shown', w['fiat'] == 'Price: €25.00' and '1 BSV = €12.67' in w['rate'] and 'rate from' in w['rate'] and 'fixed until the timer' in w['rate'], w)
    src_line = modal(pg, "const e = r.querySelector('.rate.src'); return e && [e.textContent, e.dataset.rateSource];")
    check('fiat: rate source is shown ("Rate source: CoinGecko")', src_line == ['Rate source: CoinGecko', 'coingecko'], src_line)
    check('order: data-order-id shown as text in the header', 'Order #ORD-2026/11#42' in w['sub'], w['sub'])
    check('fiat: only CoinGecko was asked in test mode (no WhatsOnChain fallback needed)', all('coingecko' in c for c in net.calls) and len(net.calls) == 1, net.calls)
    check('fiat: rate request sends no referrer and no cookies', net.hdrs and all(not h.get('referer') and not h.get('cookie') for h in net.hdrs), net.hdrs[-1:])
    close(pg)
    mount(pg, dict(FIAT, **{'data-order-id': 'ORD-42', 'data-test-delay': '1500', 'data-test-confirm-delay': '1000'}))   # 25 EUR > 20 EUR: waits for 1 conf (simulated)
    click(pg); wait(pg, W('waiting')); paid = wait(pg, W('paid'), 8000)
    ev = events(pg, 'kallubi:paid')
    d = ev[0] if ev else {}
    check('fiat: kallubi:paid carries orderId + fiat facts (amount, currency, rate, rateTime, source, quotedSats)',
          paid and d.get('orderId') == 'ORD-42' and d.get('orderIdGenerated') is False and d.get('fiat', {}).get('amount') == '25.00' and d['fiat']['currency'] == 'EUR'
          and d['fiat']['rate'] == '12.67' and d['fiat']['rateSource'] == 'coingecko' and d['fiat']['quotedSats'] == 197316496 and d['requestedSats'] == 197316496 and isinstance(d['fiat']['rateTime'], int), d)
    check('paid event says serverVerify=required and has createdAt < expiresAt (15 min default)', d.get('serverVerify') == 'required' and d['expiresAt'] - d['createdAt'] == 900, d)
    close(pg)

    mount(pg, dict(FIAT, **{'data-lang': 'de', 'data-show-amount': '1'}))
    check('fiat DE: button "25,00 € bezahlen"', btn_text(pg).replace('\u00a0', ' ') == '25,00 € bezahlen', btn_text(pg))
    click(pg); wait(pg, W('waiting'))
    w = modal(pg, "return [(r.querySelector('.fiat')||{}).textContent, (r.querySelector('.rate')||{}).textContent];")
    check('fiat DE: "Preis: 25,00 €" and "1 BSV = 12,67 € · Kurs von"', w[0].replace('\u00a0', ' ') == 'Preis: 25,00 €' and '1 BSV = 12,67' in w[1] and 'Kurs von' in w[1], w)
    close(pg)

    # ================================================================ 5. rate failures -> no QR at all
    net.woc = 'down'    # CoinGecko broken AND the backup broken
    for mode in ['down', 'stale', 'future', 'zero', 'garbage', 'nan', 'notime']:
        net.cg = mode; net.calls.clear()
        mount(pg, dict(FIAT)); click(pg)
        ok = wait(pg, W('rate'), 12000)
        nq = modal(pg, "return [r.querySelectorAll('.qrwrap, .qr').length, r.textContent.includes('bitcoin:'), r.querySelector('h2').textContent, Array.from(r.querySelectorAll('a')).map(a => a.getAttribute('href')).filter(h => h && h.startsWith('bitcoin:')).length];")
        check('rate %s (EUR, backup down too): rate-unavailable view, no QR, no bitcoin: link' % mode,
              ok and nq[0] == 0 and not nq[1] and nq[3] == 0 and nq[2] == 'Exchange rate unavailable', [nq, net.calls])
        check('rate %s: no kallubi event fired' % mode, pg.evaluate("window.__ev.length") == 0, pg.evaluate("window.__ev"))
        close(pg)
    # ---- EUR backup: WhatsOnChain USD / ECB EUR/USD. Failures first (the good ECB answer is cached for 1 h afterwards).
    net.cg = 'down'; net.woc = 'ok'
    pg.goto(BASE + '/tests/v120.html'); pg.wait_for_function('window.KallubiPay')   # fresh page = empty ECB cache
    for mode in ['down', 'stale', 'future', 'implausible', 'garbage', 'html', 'jpy']:
        net.ecb = mode; net.calls.clear()
        mount(pg, dict(FIAT)); click(pg)
        ok = wait(pg, W('rate'), 12000)
        check('EUR backup: ECB %s -> no QR (rate-unavailable view)' % mode, ok and modal(pg, "return r.querySelectorAll('.qrwrap').length;") == 0 and any('data-api.ecb.europa.eu' in c for c in net.calls), [view(pg), net.calls])
        close(pg)
    net.ecb = 'ok'; net.woc = 'stale'; net.calls.clear()
    mount(pg, dict(FIAT)); click(pg)
    check('EUR backup: WhatsOnChain rate stale -> no QR even with a good ECB rate', wait(pg, W('rate'), 12000))
    close(pg)
    net.woc = 'ok'; net.calls.clear()
    mount(pg, dict(FIAT, **{'data-fallback': '0'})); click(pg)
    check('EUR backup: data-fallback="0" -> CoinGecko only, no WhatsOnChain/ECB request, no QR', wait(pg, W('rate'), 12000) and all('coingecko' in c for c in net.calls), net.calls)
    close(pg)
    net.ecb = 'old5'; net.calls.clear()
    mount(pg, dict(FIAT, **{'data-test-delay': '1500', 'data-test-confirm-delay': '800'})); click(pg)
    ok = wait(pg, W('waiting'))
    eur = 14.25 / 1.0963; micro = round(eur * 1e6); want = -(-2500 * 10**12 // micro)
    w = modal(pg, "const a = r.querySelector('.amt .v'), s = r.querySelector('.rate.src'); return [a && a.dataset.amount, s && s.textContent, s && s.dataset.rateSource];")
    check('EUR backup: CoinGecko down -> 25.00 EUR at WhatsOnChain 14.25 USD / ECB 1.0963 (5 days old = ok, e.g. after a holiday weekend)', ok and w[0] and round(float(w[0]) * 1e8) == want, [w, want])
    check('EUR backup: source shown to the buyer (WhatsOnChain USD x ECB rate + date)', w[1] and w[1].startswith('Rate source: WhatsOnChain (USD) \u00d7 ECB EUR/USD 1.0963 (') and w[2] == 'whatsonchain+ecb', w)
    wait(pg, W('paid'), 8000); ev = events(pg, 'kallubi:paid'); f = ev[0]['fiat'] if ev else {}
    check('EUR backup: event names the source and both rates (rateSource, usdRate, ecbRate, ecbDate)', f.get('rateSource') == 'whatsonchain+ecb' and f.get('usdRate') == '14.25' and f.get('ecbRate') == '1.0963' and re.match(r'^\d{4}-\d{2}-\d{2}$', f.get('ecbDate', '')), f)
    close(pg)
    net.ecb = 'down'; net.calls.clear()
    mount(pg, dict(FIAT)); click(pg)
    check('EUR backup: ECB answer is cached (ECB down later -> still quotes, no new ECB request)', wait(pg, W('waiting'), 12000) and not any('ecb' in c for c in net.calls), net.calls)
    close(pg)
    net.ecb = 'ok'
    mount(pg, dict(FIAT, **{'data-lang': 'de'})); click(pg); wait(pg, W('waiting'))
    s_de = modal(pg, "return (r.querySelector('.rate.src')||{}).textContent;")
    check('EUR backup DE: "Kursquelle: WhatsOnChain (USD) x EZB..." line', s_de and s_de.startswith('Kursquelle: WhatsOnChain (USD)'), s_de)
    close(pg)

    # ================================================================ 5b. confirmation policy: 200 EUR line, USD from ECB, 20 EUR fallback, BSV via rate
    net.cg = 'ok'; net.ecb = 'ok'
    def run_conf(attrs):
        mount(pg, dict(FIAT, **dict({'data-test-delay': '1000', 'data-test-confirm-delay': '4000'}, **attrs))); click(pg)
        wait(pg, W('waiting')); t0 = time.time()
        while time.time() - t0 < 6 and view(pg) not in ('paid', 'confirming', 'checking'): pg.wait_for_timeout(150)
        v = view(pg); txt = modal(pg, "return r.textContent;"); ev = pg.evaluate("window.__ev.map(e => [e.type, e.d.confirmationRequired, e.d.confirmAboveFiat, e.d.confirmAboveSats, e.d.confirmAboveApplied])")
        close(pg); return v, txt, ev
    # pure helpers
    u = pg.evaluate("""() => { const u = KallubiPay.util;
      return { usd: u.eurToUsdCents(20000, '1.0963'), usdFb: u.eurToUsdCents(2000, '1.0963'),
        sats: u.eurToSatsFloor(2000, 20000000), feeOk: u.feeSufficient(100, 1000, 100), feeNo: u.feeSufficient(99, 1000, 100),
        fin: u.isTxFinal({ inputs: [{ sequence: 4294967295 }], locktime: 9 }, 0, 0),
        notFin: u.isTxFinal({ inputs: [{ sequence: 4294967294 }], locktime: 100 }, 10, 50) }; }""")
    check('policy util: EUR->USD floored, 20 EUR @ 1.0963 = 21.92 USD, fee and finality',
          u == {'usd': 21926, 'usdFb': 2192, 'sats': 100000000, 'feeOk': True, 'feeNo': False, 'fin': True, 'notFin': False}, u)

    v, txt, ev = run_conf({'data-amount-fiat': '20.00'})
    check('policy: 20.00 EUR -> paid when seen (20 EUR fallback, no Broadcaster needed)', v == 'paid' and ev and ev[-1][0] == 'kallubi:paid' and ev[-1][1] is False and ev[-1][2] == '200.00', [v, ev])
    v, txt, ev = run_conf({'data-amount-fiat': '20.01'})
    check('policy: 20.01 EUR in test mode is still under 200 EUR -> 0-conf (quick check is assumed in test mode)', v == 'paid' and ev[-1][1] is False, [v, ev])
    v, txt, ev = run_conf({'data-amount-fiat': '200.01'})
    check('policy: 200.01 EUR -> waits for 1 block, buyer told "Prices above €200.00 wait…"', v == 'confirming' and 'Prices above €200.00 wait for one block confirmation.' in txt and ev and ev[0][1] is True, [v, ev, txt[:240]])
    v, txt, ev = run_conf({'data-amount-fiat': '45', 'data-confirm-above-fiat': '50'})
    check('policy: shop threshold data-confirm-above-fiat="50" -> 45 EUR paid at 0-conf in test mode', v == 'paid' and ev[-1][2] == '50.00', [v, ev])
    v, txt, ev = run_conf({'data-amount-fiat': '1', 'data-confirm-above-fiat': '0'})
    check('policy: data-confirm-above-fiat="0" -> even 1 EUR waits for 1 block', v == 'confirming' and ev[0][1] is True, [v, ev])
    v, txt, ev = run_conf({'data-amount-fiat': '20', 'data-currency': 'USD'})
    check('policy: 20.00 USD is under 20 EUR * 1.0963 = 21.92 USD -> 0-conf', v == 'paid' and ev[-1][4] == '219.26', [v, ev])
    v, txt, ev = run_conf({'data-amount-fiat': '21.93', 'data-currency': 'USD', 'data-confirm-above-fiat': '20'})
    check('policy: 21.93 USD is above 20 EUR converted (21.92) and the shop line is 20 EUR -> wait', v == 'confirming' and ev[0][1] is True, [v, ev])
    v, txt, ev = run_conf({'data-amount-fiat': '250', 'data-lang': 'de'})
    check('policy DE: 250 EUR waits, text "Preise über 200,00 € warten auf eine Blockbestätigung."', v == 'confirming' and 'Preise über 200,00\u00a0€ warten auf eine Blockbestätigung.' in txt, txt[:300])
    for attrs, needle in [({'data-confirm-above-fiat': 'abc'}, 'data-confirm-above-fiat'), ({'data-confirm-above-fiat': '20.001'}, 'data-confirm-above-fiat'),
                          ({'data-confirm-above': '0.01'}, 'data-confirm-above-fiat'), ({'data-confirm-above-fiat': '-5'}, 'data-confirm-above-fiat')]:
        mount(pg, dict(FIAT, **attrs)); e = err_text(pg)
        check('policy: bad config %s -> visible config error, no button' % json.dumps(attrs), e and needle in e, e)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-confirm-above': '0.01', 'data-confirm-above-fiat': '20'}); e = err_text(pg)
    check('policy: data-confirm-above and data-confirm-above-fiat together -> config error', e and 'data-confirm-above' in e, e)
    def attach_eur_rate():
        # Test mode stays offline, so we attach the same stubbed 12.67 EUR/BSV rate the fiat tests use.
        pg.evaluate("""() => { const w = KallubiPay.mount(document.getElementById('w'));
          if (w && w.inv) w.inv.fx = { eurMicro: 12670000, eurRate: 12.67, cur: 'EUR', micro: 12670000, rate: 12.67, source: 'test' }; }""")
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-confirm-above-fiat': '50', 'data-test': '1', 'data-test-delay': '1000'}); click(pg); attach_eur_rate(); wait(pg, W('paid'), 6000)
    d = events(pg, 'kallubi:paid'); d = d[0] if d else {}
    check('policy: BSV button may use data-confirm-above-fiat (EUR line); 0.0005 BSV at 12.67 EUR is under 50 EUR',
          d.get('confirmationRequired') is False and d.get('confirmAboveFiat') == '50.00', d)
    close(pg)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '1000'}); click(pg); attach_eur_rate(); wait(pg, W('paid'), 6000)
    d = events(pg, 'kallubi:paid'); d = d[0] if d else {}
    # 200 EUR at 12.67 EUR/BSV -> floor(200/12.67 * 1e8) sats
    check('policy: BSV default converts 200 EUR via the rate (no more 0.01 BSV line)',
          d.get('confirmationRequired') is False and d.get('confirmAboveFiat') == '200.00' and isinstance(d.get('confirmAboveSats'), int) and d['confirmAboveSats'] > 1000000, d)
    close(pg)

    net.cg = 'down'; net.woc = 'ok'; net.calls.clear()
    mount(pg, dict(FIAT, **{'data-currency': 'USD', 'data-amount-fiat': '10', 'data-test-delay': '1200', 'data-test-confirm-delay': '800'})); click(pg)
    ok = wait(pg, W('waiting'))
    a = modal(pg, "return r.querySelector('.amt .v') && r.querySelector('.amt .v').dataset.amount;")
    check('rate USD: CoinGecko down -> WhatsOnChain USD fallback (10.00 USD at 14.25 = 70175439 sats)', ok and a == '0.70175439' and any(c.endswith('/exchangerate') for c in net.calls), [a, net.calls])
    wait(pg, W('paid'), 6000); ev = events(pg, 'kallubi:paid')
    check('rate USD fallback: event names the rate source', ev and ev[0]['fiat']['rateSource'] == 'whatsonchain', ev[:1])
    close(pg)
    net.cg = 'stale'; net.woc = 'stale'
    mount(pg, dict(FIAT, **{'data-currency': 'USD'})); click(pg)
    check('rate USD: both sources stale -> no QR', wait(pg, W('rate'), 12000) and modal(pg, "return r.querySelectorAll('.qrwrap').length;") == 0)
    net.cg = 'ok'; net.woc = 'ok'
    modal(pg, "r.querySelector('.btn.gold').click(); return 1;")
    check('rate: "Try again" after the source recovers -> fresh quote + QR', wait(pg, W('waiting'), 8000) and modal(pg, "return r.querySelectorAll('.qrwrap').length;") == 1)
    close(pg)

    # ================================================================ 6. order id in events, generated ids
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '1000'}); click(pg); wait(pg, W('paid'), 6000)
    d1 = events(pg, 'kallubi:paid')[0]; close(pg)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '1000'}); click(pg); wait(pg, W('paid'), 6000)
    d2 = events(pg, 'kallubi:paid')[0]; close(pg)
    check('order: without data-order-id a random kp-… id is generated, flagged, and differs per invoice; order stays null like 1.0.0',
          re.match(r'^kp-[0-9a-f]{20}$', d1['orderId']) and d1['orderIdGenerated'] is True and d1['orderId'] != d2['orderId'] and d1['order'] is None, [d1['orderId'], d2['orderId'], d1['order']])
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '1000', 'data-order': 'legacy order 7'}); click(pg); wait(pg, W('paid'), 6000)
    d3 = events(pg, 'kallubi:paid')[0]; close(pg)
    check('order: legacy data-order with spaces keeps working (order unchanged, safe orderId generated)', d3['order'] == 'legacy order 7' and d3['orderId'].startswith('kp-'), d3)

    # ================================================================ 7. expiry + late payments
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '60000', 'data-expires-min': '1', 'data-ttl': '600'}); click(pg); wait(pg, W('waiting'))
    tm = modal(pg, "return r.querySelector('.timer').textContent;")
    check('expiry: data-expires-min=1 -> 1:00 countdown (wins over data-ttl)', tm in ('1:00', '0:59'), tm)
    close(pg)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '60000'}); click(pg); wait(pg, W('waiting'))
    tm = modal(pg, "return r.querySelector('.timer').textContent;")
    check('expiry: default window is 15:00', tm in ('15:00', '14:59'), tm)
    close(pg)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-ttl': '4', 'data-test-delay': '2500'}); click(pg)
    check('expiry: payment 1.5 s before the deadline -> paid, no late flag', wait(pg, W('paid'), 6000) and not events(pg, 'kallubi:late'))
    close(pg)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-ttl': '3', 'data-test-delay': '5000', 'data-order-id': 'LATE-1'}); click(pg)
    ex = wait(pg, W('expired'), 6000)
    nq = modal(pg, "return r.querySelectorAll('.qrwrap').length;")
    xe = events(pg, 'kallubi:expired')
    check('expiry: after the window the QR is withdrawn (expired view) and kallubi:expired fires with orderId', ex and nq == 0 and xe and xe[0]['orderId'] == 'LATE-1', xe)
    lt = wait(pg, W('late'), 6000)
    le = events(pg, 'kallubi:late')
    check('late: payment after expiry -> kallubi:late (late=true, expiredAt, orderId), NOT kallubi:paid', lt and len(le) == 1 and le[0]['late'] is True and le[0]['orderId'] == 'LATE-1'
          and le[0]['expiredAt'] == le[0]['expiresAt'] and not events(pg, 'kallubi:paid'), le)
    lv = modal(pg, "return [r.querySelector('h2').textContent, (r.querySelector('.pill')||{}).textContent, r.querySelectorAll('.qrwrap').length];")
    check('late: buyer sees "Payment arrived too late", told not to pay again, no QR', lv and lv[0] == 'Payment arrived too late' and lv[1] == 'After the deadline' and lv[2] == 0, lv)
    close(pg); click(pg); wait(pg, W('late'), 3000)
    check('late: re-opening the button shows the late notice again, never a new QR (no double payment)', view(pg) == 'late' and modal(pg, "return r.querySelectorAll('.qrwrap').length;") == 0, view(pg))
    close(pg)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-ttl': '3', 'data-test-delay': '3000'}); click(pg)
    pg.wait_for_timeout(5000)
    check('expiry boundary: payment at exactly the deadline is flagged late, not paid', events(pg, 'kallubi:late') and not events(pg, 'kallubi:paid'), [view(pg), pg.evaluate('window.__ev.map(e=>e.type)')])
    close(pg)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-ttl': '3', 'data-test-delay': '6000'}); click(pg)
    wait(pg, W('expired'), 6000); first = events(pg, 'kallubi:expired')[0]['orderId']
    modal(pg, "r.querySelector('.btn.gold').click(); return 1;"); wait(pg, W('waiting'))
    old_sats = events(pg, 'kallubi:expired')[0]['requestedSats']
    new_sats = int(round(float(modal(pg, "return r.querySelector('.amt .v').dataset.amount;")) * 1e8))
    pg.wait_for_timeout(3200)
    le = events(pg, 'kallubi:late'); pe = events(pg, 'kallubi:paid') + events(pg, 'kallubi:seen')
    if old_sats >= new_sats:   # the late tx also pays the open invoice -> it counts for the open one
        check('late vs. open invoice: tx that also pays the open invoice is credited to it (paid), not flagged late', not le and pe and view(pg) in ('paid', 'confirming'), [old_sats, new_sats, le, view(pg)])
    else:
        check('late: old invoice paid late while a new invoice is open -> kallubi:late for the OLD orderId; new invoice not hijacked',
              len(le) == 1 and le[0]['orderId'] == first and not pe and view(pg) in ('waiting', 'expired'), [old_sats, new_sats, le, view(pg)])
    close(pg)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-unique': '0', 'data-test': '1', 'data-ttl': '3', 'data-test-delay': '6000'}); click(pg)
    wait(pg, W('expired'), 6000); modal(pg, "r.querySelector('.btn.gold').click(); return 1;"); wait(pg, W('waiting'))
    ok = wait(pg, W('paid'), 5000)
    check('late vs. open invoice (same amount, data-unique=0): the payment is credited to the open invoice, one tx counts once', ok and len(events(pg, 'kallubi:paid')) == 1 and not events(pg, 'kallubi:late'), pg.evaluate('window.__ev.map(e=>e.type)'))
    close(pg)
    net.cg = 'ok'; net.calls.clear()
    mount(pg, dict(FIAT, **{'data-ttl': '3'})); click(pg); wait(pg, W('waiting')); wait(pg, W('expired'), 6000)
    n1 = len(net.calls); net.eur = 13.00
    modal(pg, "r.querySelector('.btn.gold').click(); return 1;"); wait(pg, W('waiting'))
    a = modal(pg, "return r.querySelector('.amt .v') && r.querySelector('.amt .v').dataset.amount;")
    check('fiat expiry: "Try again" re-quotes with a fresh rate (25.00 EUR at 13.00 = 192307693 sats)', len(net.calls) == n1 + 1 and a == '1.92307693', [n1, len(net.calls), a])
    net.eur = 12.67
    close(pg)

    # ================================================================ 8. fiat + shipping
    mount(pg, dict(FIAT, **{'data-shipping': '1', 'data-order-id': 'SHIP-9'})); click(pg); wait(pg, W('shipping'))
    sa = modal(pg, "return r.querySelector('.samt b').textContent;")
    check('fiat + shipping: form shows the fiat price', sa == '€25.00', sa)
    modal(pg, """const v = {name: 'Erika Mustermann', street: 'Musterweg 1', postalCode: '12345', city: 'Musterstadt', country: 'DE'};
      for (const k in v) { const i = r.querySelector('[name=' + k + ']'); i.value = v[k]; i.dispatchEvent(new Event('input')); } r.querySelector('form.sf button[type=submit]').click(); return 1;""")
    ok = wait(pg, W('waiting'))
    se = events(pg, 'kallubi:shipping')
    check('fiat + shipping: quote follows the address, kallubi:shipping has orderId', ok and se and se[0]['orderId'] == 'SHIP-9', se)
    close(pg)

    # ================================================================ 9. backward compatibility: no new attribute = DOM of v1.0.0
    CFGS = [{'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-unique': '0', 'data-test-delay': '1500'},
            {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '1500', 'data-theme': 'light', 'data-lang': 'de', 'data-order': 'A-1', 'data-label': 'Hoodie', 'data-show-amount': '1'},
            {'data-to': ADDR, 'data-amount': '0.02', 'data-confirm-above': '0.01', 'data-test': '1', 'data-test-delay': '1500', 'data-test-confirm-delay': '1500', 'data-style': 'outline', 'data-size': 'sm'},
            {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-ttl': '3', 'data-test-delay': '60000'},
            {'data-to': '1BAD', 'data-amount': '0.0005'}, {'data-to': ADDR, 'data-amount': '0.0005', 'data-currency': 'EURO'}]
    snaps = {}
    for ver, page in (('old', '/tests/blank-v100.html'), ('new', '/tests/v120.html')):
        pg.goto(BASE + page); pg.wait_for_function('window.KallubiPay')
        ss = []
        for cfg in CFGS:
            mount(pg, cfg); ss.append(snap_btn(pg))
            if cfg['data-to'] != ADDR or 'data-currency' in cfg: continue
            click(pg); wait(pg, W('waiting')); ss.append(snap_modal(pg))
            target = 'expired' if 'data-ttl' in cfg else 'paid'
            ok = wait(pg, W(target), 12000); ss.append(snap_modal(pg) if ok else 'NO-' + target); ss.append(snap_btn(pg))
            close(pg)
        snaps[ver] = ss
    vers = pg.evaluate('KallubiPay.version')
    diffs = [i for i in range(max(len(snaps['old']), len(snaps['new']))) if (snaps['old'][i:i+1] or [None]) != (snaps['new'][i:i+1] or [None])]
    check('compat: without new attributes button + waiting/paid/confirming/expired DOM identical to v1.0.0 (%d snapshots)' % len(snaps['old']), not diffs and len(snaps['old']) == len(snaps['new']) and vers == '1.2.0',
          diffs and list(__import__('difflib').unified_diff(str(snaps['old'][diffs[0]]).split('\n'), str(snaps['new'][diffs[0]]).split('\n'), lineterm='', n=1))[:14])

    # ================================================================ 10. strict CSP page with fiat
    p2 = ctx.new_page(); viol = []
    p2.on('console', lambda m: ('Content Security Policy' in m.text or 'Refused' in m.text) and viol.append(m.text))
    p2.goto(BASE + '/tests/csp-fiat.html'); p2.wait_for_function("document.querySelector('#b .kallubi-pay-host')")
    p2.evaluate("document.querySelector('#b .kallubi-pay-host').shadowRoot.querySelector('button').click()")
    okc = False   # wait_for_function needs eval, which this CSP blocks -> poll with evaluate instead
    for _ in range(40):
        v2 = p2.evaluate("(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view; })()")
        if v2 in ('waiting', 'confirming'): okc = True; break
        p2.wait_for_timeout(200)
    bg = p2.evaluate("getComputedStyle(document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.modal')).borderRadius")
    check('CSP: fiat button works under default-src none / style-src none (styles applied, no violations)', okc and bg == '22px' and not viol, [okc, bg, viol[:2], p2.evaluate("(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view; })()"), net.calls[-2:], net.cg])
    p2.close()

    # ================================================================ 11. static checks on the source
    code = re.sub(r'/\*.*?\*/', '', src, flags=re.S); code = re.sub(r'(?m)^\s*//.*$|\s//\s.*$', '', code)
    banned = [p for p in ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'localStorage', 'sessionStorage', 'document.cookie'] if p in code]
    check('source: no innerHTML/outerHTML/insertAdjacentHTML/document.write/eval/new Function/storage/cookies', not banned, banned)
    hosts = sorted(set(h for h in re.findall(r"https://([a-z0-9.-]+)", src) if h != '-'))   # '-' = the text "https://-URL" in an error message
    check('source: only known hosts (whatsonchain, coingecko, ecb data portal, kallubi node + site, BSV Broadcaster, w3 namespace)', set(hosts) <= {'api.whatsonchain.com', 'api.coingecko.com', 'data-api.ecb.europa.eu', 'kallubi-bsv-explorer.de', 'node.kallubi-bsv-explorer.de', 'arcade-eu-1.bsvblockchain.tech', 'arcade-us-1.bsvblockchain.tech', 'arcade.gorillapool.io', 'www.w3.org'}, hosts)
    check('no JS errors / no dialogs during the run', not errors and not dialogs, [errors[:3], dialogs])
    b.close()

passed = sum(r['ok'] for r in results)
print(json.dumps({'passed': passed, 'failed': len(results) - passed}))
json.dump(results, open('tests/results-v120.json', 'w'), indent=1, ensure_ascii=False)
sys.exit(0 if passed == len(results) else 1)
