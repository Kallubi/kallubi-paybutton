"""v1.2.1: every Kallubi mark in the widget is the official logo (slanted K), and the QR with the logo in the middle still scans.
Run:  python3 -m http.server 8765 --bind 127.0.0.1 &   then   python tests/test_logo.py"""
import json, sys, cv2, numpy as np
from playwright.sync_api import sync_playwright
KPATH = 'M40.7 5.65 26.8 20.46 26.8 52.8 40.7 38.14zM80.63 20.8 61.76 20.8 26.8 58.76 26.8 95.3 40.7 80.54 40.7 62.64zM57.4 50.95 47.26 61.75 66.96 83 87.23 83z'
OLD = ['M27 18h16v64H27z', 'M43 52 70 18h19L50 64z', 'M55 57 66 47 89 82H70z']
results = []
def check(name, cond, info=''):
    results.append({'test': name, 'ok': bool(cond), 'info': info}); print(('PASS ' if cond else 'FAIL ') + name + (('  [' + str(info) + ']') if info else ''))
LOGOS = """(root) => [...root.querySelectorAll('svg.klogo')].map(s => ({d: [...s.querySelectorAll('path')].map(p => p.getAttribute('d')),
  grad: s.querySelector('linearGradient') && s.querySelector('linearGradient').id, fill: s.querySelector('path').getAttribute('fill'),
  stops: s.querySelectorAll('stop').length, w: s.getAttribute('width')}))"""
def decode(png):
    img = cv2.imdecode(np.frombuffer(png, np.uint8), 1); out = set()
    for det in (cv2.QRCodeDetector(), cv2.QRCodeDetectorAruco()):
        for scale in (1, 0.5, 2):
            im = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
            im = cv2.copyMakeBorder(im, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=(255, 255, 255))
            t, _, _ = det.detectAndDecode(im)
            if t: out.add(t)
    return out
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    pg = b.new_page(viewport={'width': 1280, 'height': 900}, device_scale_factor=2)
    pg.goto('http://127.0.0.1:8765/demo/'); pg.wait_for_function('document.querySelectorAll(".kallubi-pay-host").length >= 6')
    check('version 1.2.0', pg.evaluate('window.KallubiPay && KallubiPay.version') == '1.2.0', pg.evaluate('window.KallubiPay && KallubiPay.version'))
    for theme in ('dark', 'light'):
        lg = pg.evaluate("(f) => (eval(f))(document.querySelector('#btn-%s .kallubi-pay-host').shadowRoot)" % theme, LOGOS)
        check(theme + ' button: "Powered by Kallubi" mark is the real logo', len(lg) == 1 and lg[0]['d'] == [KPATH] and lg[0]['stops'] == 7, lg)
        pg.evaluate("document.querySelector('#btn-%s .kallubi-pay-host').shadowRoot.querySelector('button').click()" % theme)
        pg.wait_for_function("(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view === 'waiting'; })()")
        pg.wait_for_timeout(600)
        lg = pg.evaluate("(f) => (eval(f))(document.querySelector('[data-kallubi-modal]').shadowRoot)", LOGOS)
        check(theme + ' dialog: header, QR centre and footer logos are all the real logo', len(lg) == 3 and all(l['d'] == [KPATH] for l in lg) and sorted(l['w'] for l in lg) == ['14', '30', '42'], [(l['w'], len(l['d'])) for l in lg])
        ids = [l['grad'] for l in lg]; check(theme + ' dialog: gradient ids unique and referenced', len(set(ids)) == 3 and all(l['fill'] == 'url(#%s)' % l['grad'] for l in lg), ids)
        html = pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.innerHTML")
        check(theme + ' dialog: no old hand-drawn K paths, no external image', not any(o in html for o in OLD) and '<img' not in html and 'href="http' not in html.split('<svg')[1] if '<svg' in html else True)
        uri = pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.qrwrap').dataset.uri")
        png = pg.evaluate_handle("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.qrwrap')").as_element().screenshot()
        open('/tmp/qr-%s.png' % theme, 'wb').write(png)
        got = decode(png)
        check(theme + ' QR with real logo in the centre scans to the exact payment URI', got == {uri}, [uri, list(got)])
        pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    b.close()
json.dump(results, open('tests/results-logo.json', 'w'), indent=1)
f = sum(not r['ok'] for r in results); print(json.dumps({'passed': len(results) - f, 'failed': f})); sys.exit(1 if f else 0)
