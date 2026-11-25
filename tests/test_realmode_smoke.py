"""Real mode (no data-test): the widget asks the own node first (mocked here as "down", as long as the fix pack is not live),
then polls only the public fallback for real, sends no referrer/cookies, and does not crash."""
from playwright.sync_api import sync_playwright
import json
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome'); pg = b.new_page()
    pg.route('https://node.kallubi-bsv-explorer.de/**', lambda r: r.abort('connectionrefused'))
    reqs, errs = [], []
    pg.on('request', lambda r: reqs.append((r.url, r.headers.get('referer'), r.headers.get('cookie'))))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8765/demo/'); pg.wait_for_function('window.KallubiPay')
    pg.evaluate("""() => { const d = document.createElement('div'); d.id = 'real'; Object.assign(d.dataset, {kallubiPay: '', to: '1111111111111111111114oLvT2', amount: '0.0001'}); document.body.appendChild(d); }""")
    pg.wait_for_function("document.querySelector('#real .kallubi-pay-host')")
    pg.evaluate("document.querySelector('#real .kallubi-pay-host').shadowRoot.querySelector('button').click()")
    pg.wait_for_timeout(12000)
    ext = [r for r in reqs if not r[0].startswith('http://127.0.0.1')]
    hosts = sorted({r[0].split('/')[2] for r in ext})
    view = pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.modal').dataset.view")
    allowed = {
        'api.whatsonchain.com', 'node.kallubi-bsv-explorer.de',
        'api.coingecko.com', 'data-api.ecb.europa.eu',
        'arcade-eu-1.bsvblockchain.tech', 'arcade-us-1.bsvblockchain.tech', 'arcade.gorillapool.io',
    }
    ok = set(hosts) <= allowed and 'node.kallubi-bsv-explorer.de' in hosts and all(not r[1] and not r[2] for r in ext) and not errs and view == 'waiting'
    def path_of(u):
        if '/v1/bsv/main' in u: return u.split('/v1/bsv/main', 1)[1]
        return u
    print(json.dumps({'ok': ok, 'hosts': hosts, 'requests': len(ext), 'sample': [path_of(r[0]) for r in ext[:6]], 'referer_sent': any(r[1] for r in ext), 'errors': errs, 'view': view}))
    b.close()
