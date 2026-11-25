"""v1.2.0 screenshots (test mode, placeholder address, mocked exchange rates) -> shots/v120/*.png"""
import json, os, time, datetime
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8765'; ADDR = '1111111111111111111114oLvT2'; OUT = 'shots/v120'
os.makedirs(OUT, exist_ok=True)
def W(v): return "(() => { const h = document.querySelector('[data-kallubi-modal]'); return !!h && h.shadowRoot.querySelector('.modal').dataset.view === '%s'; })()" % v
mode = {'cg': 'ok', 'woc': 'ok'}; held = []
def cg(route):
    if mode['cg'] == 'hold': held.append(route); return
    if mode['cg'] == 'down': return route.fulfill(status=503, body='')
    route.fulfill(status=200, body=json.dumps({'bitcoin-cash-sv': {'eur': 12.67, 'usd': 13.9, 'last_updated_at': int(time.time()) - 40}}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
def woc(route):
    if mode['woc'] == 'down' or not route.request.url.endswith('/exchangerate'): return route.fulfill(status=503, body='', headers={'Access-Control-Allow-Origin': '*'})
    route.fulfill(status=200, body=json.dumps({'rate': 14.25, 'time': int(time.time()) - 20, 'currency': 'USD'}), headers={'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
def ecb(route):
    d = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    route.fulfill(status=200, body='KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,%s,1.0963\n' % d, headers={'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': '*'})
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    def page(w, h, dark=True):
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, color_scheme='dark' if dark else 'light')
        ctx.route('https://api.coingecko.com/**', cg); ctx.route('https://api.whatsonchain.com/**', woc); ctx.route('https://data-api.ecb.europa.eu/**', ecb)
        ctx.route('https://node.kallubi-bsv-explorer.de/**', lambda r: r.fulfill(status=503, body=''))
        p = ctx.new_page(); p.goto(BASE + '/tests/v120.html'); p.wait_for_function('window.KallubiPay')
        p.add_style_tag(content='body{margin:0;min-height:100vh;background:%s;font-family:system-ui;padding:40px}' % ('#0b0b10' if dark else '#f4f1ea'))
        return p
    def mount(p, a):
        p.evaluate("""(a) => { const s = document.getElementById('slot'); s.textContent = ''; const d = document.createElement('div'); d.setAttribute('data-kallubi-pay', ''); d.id = 'w';
          for (const k in a) d.setAttribute(k, a[k]); s.appendChild(d); }""", a)
        p.wait_for_function("document.querySelector('#w .kallubi-pay-host')")
    def click(p): p.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').click()")
    def shot(p, name): p.wait_for_timeout(350); p.screenshot(path=os.path.join(OUT, name)); print(name)
    F = {'data-to': ADDR, 'data-amount-fiat': '25.00', 'data-currency': 'EUR', 'data-test': '1', 'data-test-delay': '600000', 'data-merchant': 'Merch Shop', 'data-order-id': 'ORDER-1042', 'data-label': 'Gold Logo Hoodie'}

    p = page(1100, 900); mount(p, dict(F, **{'data-theme': 'dark'})); click(p); p.wait_for_function(W('waiting')); shot(p, '01-fiat-eur-dark-en.png')
    p = page(1100, 900, False); mount(p, dict(F, **{'data-theme': 'light', 'data-lang': 'de'})); click(p); p.wait_for_function(W('waiting')); shot(p, '02-fiat-eur-light-de.png')
    mode['cg'] = 'hold'; p = page(1100, 700); mount(p, dict(F, **{'data-theme': 'dark'})); click(p); p.wait_for_function(W('quoting')); shot(p, '03-kurs-wird-geladen.png')
    for r in held: r.fulfill(status=503, body='')
    held.clear(); mode['cg'] = 'down'; mode['woc'] = 'down'
    p = page(1100, 900); mount(p, dict(F, **{'data-theme': 'dark'})); click(p); p.wait_for_function(W('rate'), timeout=20000); shot(p, '04-kein-kurs-kein-qr-en.png')
    p = page(1100, 900, False); mount(p, dict(F, **{'data-theme': 'light', 'data-lang': 'de'})); click(p); p.wait_for_function(W('rate'), timeout=20000); shot(p, '05-kein-kurs-kein-qr-de.png')
    mode['cg'] = 'ok'; mode['woc'] = 'ok'
    p = page(1100, 900); mount(p, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-ttl': '3', 'data-test-delay': '600000', 'data-order-id': 'ORDER-1043', 'data-theme': 'dark'}); click(p)
    p.wait_for_function(W('expired'), timeout=8000); shot(p, '06-zeitfenster-abgelaufen.png')
    p = page(1100, 900); mount(p, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-ttl': '3', 'data-test-delay': '5000', 'data-order-id': 'ORDER-1044', 'data-theme': 'dark'}); click(p)
    p.wait_for_function(W('late'), timeout=10000); shot(p, '07-zahlung-zu-spaet-en.png')
    p = page(1100, 900, False); mount(p, {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-ttl': '3', 'data-test-delay': '5000', 'data-order-id': 'ORDER-1044', 'data-theme': 'light', 'data-lang': 'de'}); click(p)
    p.wait_for_function(W('late'), timeout=10000); shot(p, '08-zahlung-zu-spaet-de.png')
    p = page(1100, 900); mount(p, dict(F, **{'data-theme': 'dark', 'data-test-delay': '1200', 'data-test-confirm-delay': '1500'})); click(p)
    p.wait_for_function(W('paid'), timeout=10000); shot(p, '09-bezahlt-mit-bestellnummer.png')
    # config errors gallery
    p = page(900, 620, False)
    p.evaluate("""() => { const s = document.getElementById('slot'); s.textContent = '';
      const cases = [['data-order-id with HTML', {'data-amount-fiat': '25.00', 'data-currency': 'EUR', 'data-order-id': '<img src=x onerror=alert(1)>'}],
        ['fiat amount with comma', {'data-amount-fiat': '25,00', 'data-currency': 'EUR'}], ['unsupported currency', {'data-amount-fiat': '25.00', 'data-currency': 'GBP'}],
        ['both amounts', {'data-amount': '0.001', 'data-amount-fiat': '25.00', 'data-currency': 'EUR'}], ['bad window', {'data-amount-fiat': '25.00', 'data-currency': 'USD', 'data-expires-min': '90'}],
        ['fiat price with the BSV threshold', {'data-amount-fiat': '25.00', 'data-currency': 'EUR', 'data-confirm-above': '0.01'}]];
      for (const [t, a] of cases) { const h = document.createElement('div'); h.textContent = t; h.style.cssText = 'font:600 13px system-ui;margin:14px 0 6px;color:#333'; s.appendChild(h);
        const d = document.createElement('div'); d.setAttribute('data-kallubi-pay', ''); d.setAttribute('data-to', '1111111111111111111114oLvT2'); for (const k in a) d.setAttribute(k, a[k]); s.appendChild(d); } }""")
    p.wait_for_timeout(500); p.set_viewport_size({'width': 900, 'height': 760}); shot(p, '10-konfig-fehler-als-text.png')
    p = page(390, 844); mount(p, dict(F, **{'data-theme': 'dark'})); click(p); p.wait_for_function(W('waiting')); shot(p, '11-mobil-fiat.png')
    # EUR backup rate (CoinGecko down): WhatsOnChain USD / ECB reference rate, source shown
    mode['cg'] = 'down'
    p = page(1100, 900); mount(p, dict(F, **{'data-theme': 'dark'})); click(p); p.wait_for_function(W('waiting')); shot(p, '12-eur-ersatzkurs-ezb-en.png')
    p = page(1100, 900, False); mount(p, dict(F, **{'data-theme': 'light', 'data-lang': 'de'})); click(p); p.wait_for_function(W('waiting')); shot(p, '13-eur-ersatzkurs-ezb-de.png')
    mode['cg'] = 'ok'
    # confirmation policy: above 20 EUR wait for 1 block; up to 20 EUR paid at 0-conf
    p = page(1100, 900); mount(p, dict(F, **{'data-theme': 'dark', 'data-test-delay': '1200', 'data-test-confirm-delay': '600000'})); click(p)
    p.wait_for_function(W('confirming'), timeout=10000); shot(p, '14-ueber-20eur-wartet-auf-bestaetigung-en.png')
    p = page(1100, 900, False); mount(p, dict(F, **{'data-theme': 'light', 'data-lang': 'de', 'data-test-delay': '1200', 'data-test-confirm-delay': '600000'})); click(p)
    p.wait_for_function(W('confirming'), timeout=10000); shot(p, '15-ueber-20eur-wartet-auf-bestaetigung-de.png')
    p = page(1100, 900); mount(p, dict(F, **{'data-theme': 'dark', 'data-amount-fiat': '19.90', 'data-label': 'Kallubi Cap', 'data-test-delay': '1200'})); click(p)
    p.wait_for_function(W('paid'), timeout=10000); shot(p, '16-bis-20eur-sofort-bezahlt-0conf.png')
    b.close()
