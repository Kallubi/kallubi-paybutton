"""Screenshots of the working demo -> shots/"""
from playwright.sync_api import sync_playwright
W = "(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view === '%s'; })()"
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    pg = b.new_page(viewport={'width': 1280, 'height': 900}, device_scale_factor=2)
    pg.goto('http://127.0.0.1:8765/demo/'); pg.wait_for_function('document.querySelectorAll(".kallubi-pay-host").length >= 6')
    pg.wait_for_timeout(400)
    pg.screenshot(path='shots/00-demo-overview.png', full_page=True)
    for theme in ('dark', 'light'):
        pg.evaluate("document.querySelector('#btn-%s .kallubi-pay-host').shadowRoot.querySelector('button').click()" % theme)
        pg.wait_for_function(W % 'waiting'); pg.wait_for_timeout(2300)
        pg.screenshot(path='shots/%s-waiting.png' % theme)
        pg.evaluate_handle("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.modal')").as_element().screenshot(path='shots/%s-waiting-modal.png' % theme)
        pg.wait_for_function(W % 'paid', timeout=15000); pg.wait_for_timeout(400)
        pg.screenshot(path='shots/%s-paid.png' % theme)
        pg.evaluate_handle("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.modal')").as_element().screenshot(path='shots/%s-paid-modal.png' % theme)
        pg.keyboard.press('Escape')
    # expired view (dark) for completeness
    pg.evaluate("""() => { const d = document.createElement('div'); d.id = 'exp'; Object.assign(d.dataset, {kallubiPay: '', to: '1111111111111111111114oLvT2', amount: '0.0012', merchant: 'Night Shop', label: 'Gold Logo Hoodie', theme: 'dark', test: '1', testDelay: '60000', ttl: '3'}); d.style.display='none'; document.body.appendChild(d); }""")
    pg.wait_for_function("document.querySelector('#exp .kallubi-pay-host')")
    pg.evaluate("document.querySelector('#exp .kallubi-pay-host').shadowRoot.querySelector('button').click()")
    pg.wait_for_function(W % 'expired', timeout=8000); pg.wait_for_timeout(300)
    pg.evaluate_handle("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.modal')").as_element().screenshot(path='shots/dark-expired-modal.png')
    b.close()
