"""v1.2.1 screenshots (test mode, placeholder address) -> shots/c12-*.png"""
from playwright.sync_api import sync_playwright
W = "(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view === '%s'; })()"
M = "document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.modal')"
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    pg = b.new_page(viewport={'width': 1100, 'height': 900}, device_scale_factor=2)
    pg.goto('http://127.0.0.1:8765/demo/'); pg.wait_for_function('document.querySelectorAll(".kallubi-pay-host").length >= 6'); pg.wait_for_timeout(300)
    pg.evaluate("document.querySelector('#btn-dark .kallubi-pay-host').shadowRoot.querySelector('button').click()")
    pg.wait_for_function(W % 'waiting'); pg.wait_for_timeout(1200)
    pg.evaluate_handle(M).as_element().screenshot(path='shots/c12-dialog-dark.png')
    pg.wait_for_function(W % 'paid', timeout=15000); pg.wait_for_timeout(900)
    pg.evaluate_handle(M).as_element().screenshot(path='shots/c12-paid-dark.png')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(500)
    pg.evaluate("document.querySelector('#btn-light .kallubi-pay-host').shadowRoot.querySelector('button').click()")
    pg.wait_for_function(W % 'waiting'); pg.wait_for_timeout(1200)
    pg.evaluate_handle(M).as_element().screenshot(path='shots/c12-light.png')
    b.close()
