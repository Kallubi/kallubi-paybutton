"""shots/lang-grid.png: waiting dialog in en / de / es / fr (dark theme, test mode)"""
import base64
from playwright.sync_api import sync_playwright
W = "(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view === 'waiting'; })()"
LANGS = [('en', 'English'), ('de', 'Deutsch'), ('es', 'Español'), ('fr', 'Français')]
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    pg = b.new_page(viewport={'width': 900, 'height': 1000}, device_scale_factor=2)
    pg.goto('http://127.0.0.1:8765/tests/blank.html'); pg.wait_for_function('window.KallubiPay')
    imgs = []
    for l, name in LANGS:
        pg.evaluate("""(l) => { const s = document.getElementById('slot'); s.textContent = ''; const d = document.createElement('div'); d.id = 'w';
          Object.assign(d.dataset, {kallubiPay: '', to: '1111111111111111111114oLvT2', amount: '0.0005', merchant: 'Kallubi Demo Shop', order: '1042', test: '1', testDelay: '600000', theme: 'dark', lang: l});
          s.appendChild(d); }""", l)
        pg.wait_for_function("document.querySelector('#w .kallubi-pay-host')")
        pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').click()")
        pg.wait_for_function(W); pg.wait_for_timeout(1300)
        png = pg.evaluate_handle("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.modal')").as_element().screenshot()
        imgs.append((name, l, base64.b64encode(png).decode()))
        pg.keyboard.press('Escape')
    cells = ''.join('<figure><figcaption>%s <span>data-lang="%s"</span></figcaption><img src="data:image/png;base64,%s"></figure>' % c for c in imgs)
    html = ('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#0b0b0f;font-family:system-ui,sans-serif;color:#f5d76e;padding:28px}'
            'h1{font-size:22px;margin:0 0 18px;color:#fff3cf}h1 b{color:#f0c14b}.g{display:grid;grid-template-columns:repeat(2,400px);gap:26px 30px}'
            'figure{margin:0}figcaption{font-weight:700;font-size:16px;margin:0 0 8px}figcaption span{font:500 12px ui-monospace,monospace;color:#a8a29e;margin-left:6px}'
            'img{width:400px;display:block;border-radius:22px}</style></head><body><h1><b>Kallubi Pay Button v1.0.0</b> · multi-language</h1><div class="g">%s</div></body></html>' % cells)
    pg2 = b.new_page(viewport={'width': 890, 'height': 600}, device_scale_factor=2)
    pg2.set_content(html); pg2.wait_for_timeout(300)
    pg2.screenshot(path='shots/lang-grid.png', full_page=True)
    b.close()
print('shots/lang-grid.png')
