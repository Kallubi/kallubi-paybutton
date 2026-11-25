"""Screenshot of the "Payment seen – waiting for 1 confirmation" state (test mode, threshold reached) -> shots/dark-confirming-modal.png"""
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    pg = b.new_page(viewport={'width': 1100, 'height': 860}, device_scale_factor=2)
    pg.goto('http://127.0.0.1:8765/tests/blank.html'); pg.wait_for_function('window.KallubiPay')
    pg.evaluate("""() => { document.body.style.background = '#0b0b0f'; const d = document.createElement('div'); d.id = 'w';
      Object.entries({'data-kallubi-pay': '', 'data-to': '1111111111111111111114oLvT2', 'data-amount': '0.05', 'data-label': 'Gold Logo Hoodie',
        'data-merchant': 'Demo Shop', 'data-theme': 'dark', 'data-test': '1', 'data-test-delay': '1500', 'data-test-confirm-delay': '600000'}).forEach(([k, v]) => d.setAttribute(k, v));
      document.getElementById('slot').appendChild(d); KallubiPay.mount && KallubiPay.mount(d) }""")
    pg.wait_for_timeout(500)
    pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').click()")
    pg.wait_for_timeout(9000)
    pg.screenshot(path='shots/dark-confirming-modal.png')
    b.close()
