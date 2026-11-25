"""v1.2.0 payment detection: own node first, public fallback where needed, amounts only from verified raw tx.
Offline + deterministic: both sources mocked with Playwright route() (tests/mockchain.py), incl. hostile answers.
Run:  python3 -m http.server 8765 --bind 127.0.0.1 &   then   python tests/test_node.py   (takes ~3 min: drop detection waits 2 min)"""
import json, re, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from mockchain import MockChain, build_tx, NODE, FALLBACK

BASE = 'http://127.0.0.1:8765'
ADDR = '1111111111111111111114oLvT2'
SCRIPT = '76a914' + '00' * 20 + '88ac'
OTHER = '76a914' + '11' * 20 + '88ac'
results = []
def check(name, cond, info=''):
    results.append({'test': name, 'ok': bool(cond), 'info': info})
    print(('PASS ' if cond else 'FAIL ') + name + (('  [' + str(info)[:300] + ']') if info != '' else ''))

def mount(pg, attrs, wid='w', clear=True):
    pg.evaluate("""([a, id, clear]) => { const s = document.getElementById('slot'); if (clear) s.textContent = ''; const d = document.createElement('div');
      d.setAttribute('data-kallubi-pay', ''); d.id = id; for (const k in a) d.setAttribute(k, a[k]); s.appendChild(d); }""", [attrs, wid, clear])
    pg.wait_for_function("(id) => document.querySelector('#' + id + ' .kallubi-pay-host')", arg=wid)
def click(pg, wid='w'): pg.evaluate("(id) => document.querySelector('#' + id + ' .kallubi-pay-host').shadowRoot.querySelector('button').click()", wid)
def invoice_sats(pg):
    return round(float(pg.evaluate("Array.from(document.querySelectorAll('[data-kallubi-modal]')).pop().shadowRoot.querySelector('[data-amount]').getAttribute('data-amount')")) * 1e8)
def events(pg, t=None): return [e for e in pg.evaluate('window.__ev') if t is None or e['type'] == t]
def view(pg): return pg.evaluate("(() => { const h = Array.from(document.querySelectorAll('[data-kallubi-modal]')).pop(); const d = h && h.shadowRoot.querySelector('.modal'); return d && d.getAttribute('data-view'); })()")
def modal_text(pg): return pg.evaluate("(() => { const h = Array.from(document.querySelectorAll('[data-kallubi-modal]')).pop(); return h ? h.shadowRoot.textContent : ''; })()")
def wait(pg, js, ms):
    try: pg.wait_for_function(js, timeout=ms); return True
    except Exception: return False
PAID = "window.__ev.some(e => e.type === 'kallubi:paid')"
SEEN = "window.__ev.some(e => e.type === 'kallubi:seen')"

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    b2 = pw.chromium.launch(executable_path='/usr/bin/google-chrome')   # 2nd browser: side-by-side pages are never background tabs
    def page(node='noindex', browser=None, **kw):
        ctx = (browser or b).new_context(viewport={'width': 1100, 'height': 900}); ch = MockChain(SCRIPT, node=node)
        for k, v in kw.items(): setattr(ch, k, v)
        ch.route_all(ctx); pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/tests/blank.html'); pg.wait_for_function('window.KallubiPay')
        return ctx, pg, ch, errs
    def pay_flow(node='noindex', amount='0.005', pay=None, wait_ms=12000, attrs=None, **kw):
        ctx, pg, ch, errs = page(node, **kw)
        a = {'data-to': ADDR, 'data-amount': amount, 'data-poll-ms': '1000'}; a.update(attrs or {})
        mount(pg, a); click(pg); pg.wait_for_timeout(1500)
        inv = invoice_sats(pg)
        if pay is None: ch.pay_sats = inv
        else: pay(ch, inv)
        ch.phase = 'mempool'
        ok = wait(pg, PAID, wait_ms)
        return ctx, pg, ch, errs, inv, ok

    # ---------- source selection
    ctx, pg, ch, errs, inv, ok = pay_flow('index')
    d = events(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('node with address index: paid, everything from the own node, fallback never contacted', ok and d.get('sats') == inv and d.get('txid') == ch.txid and ch.fb_calls == [], [ok, ch.fb_calls[:3]])
    check('node with index: tx bytes fetched as hex from the node', any(c.endswith('/hex') for c in ch.node_calls) and any(c.startswith('/address/') and 'history?limit=20' in c for c in ch.node_calls), ch.node_calls[:4])
    check('node with index: no JS errors', not errs, errs); ctx.close()

    ctx, pg, ch, errs, inv, ok = pay_flow('noindex')
    check('node without address index: lists via fallback, tx hex + status via own node', ok and any('/unconfirmed/history' in c for c in ch.fb_calls) and not any(c.startswith('/tx/') for c in ch.fb_calls) and any(c.endswith('/hex') for c in ch.node_calls), [ok, ch.fb_calls[:4]])
    n_addr_node = sum(1 for c in ch.node_calls if c.startswith('/address/'))
    check('node without index: asked once, then remembers "not available" (no extra node load)', n_addr_node == 1, n_addr_node); ctx.close()

    ctx, pg, ch, errs, inv, ok = pay_flow('down')
    check('own node down: everything via fallback, still paid', ok and any(c.endswith('/hex') for c in ch.fb_calls), [ok, ch.fb_calls[:5]])
    check('own node down: no JS errors', not errs, errs); ctx.close()

    # ---------- adversarial answers
    ctx, pg, ch, errs, inv, ok = pay_flow('index', tamper='hex')
    d = events(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('node serves bytes of ANOTHER tx (10x amount): rejected by txid check, fallback hex used, real amount', ok and d.get('sats') == inv and any(c.endswith('/hex') for c in ch.fb_calls), d)
    ctx.close()
    ctx, pg, ch, errs, inv, ok = pay_flow('index', tamper='both', wait_ms=9000)
    check('both sources serve forged bytes: never paid', not ok and not events(pg), events(pg)); ctx.close()
    ctx, pg, ch, errs, inv, ok = pay_flow('down', pay=lambda c, i: setattr(c, 'pay_sats', i - 1), tamper='json', wait_ms=9000)
    check('1 sat short, fallback JSON claims 100x: amount comes from raw hex only -> not paid', not ok, events(pg)); ctx.close()
    ctx, pg, ch, errs, inv, ok = pay_flow('index', pay=lambda c, i: setattr(c, 'pay_sats', i - 1), wait_ms=9000)
    check('underpayment by 1 sat: not paid', not ok); ctx.close()
    ctx, pg, ch, errs, inv, ok = pay_flow('index', pay=lambda c, i: setattr(c, 'pay_sats', i + 500))
    d = events(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('overpayment: paid with the real (higher) amount', ok and d.get('sats') == inv + 500 and d.get('requestedSats') == inv, d); ctx.close()
    ctx, pg, ch, errs, inv, ok = pay_flow('index', pay=lambda c, i: c.set_tx([(i, OTHER)]), wait_ms=9000)
    check('right amount to a different address: not paid', not ok); ctx.close()
    ctx, pg, ch, errs, inv, ok = pay_flow('index', pay=lambda c, i: c.set_tx([(i // 2, SCRIPT), (0, '006a0101'), (i - i // 2, SCRIPT)]))
    d = events(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('payment split over two outputs to the address (+ OP_RETURN): summed exactly', ok and d.get('sats') == inv, d); ctx.close()
    ctx, pg, ch, errs, inv, ok = pay_flow('index', pay=lambda c, i: c.set_tx([(i, SCRIPT + '6a0474657374')]), wait_ms=9000)
    check('output script = P2PKH + extra data: not counted (exact script match only)', not ok); ctx.close()
    ctx, pg, ch, errs, inv, ok = pay_flow('noindex', big=True)
    check('node announces a 64 MB hex body: refused, fallback hex verified instead', ok and any(c.endswith('/hex') for c in ch.fb_calls), [ok, ch.fb_calls[-3:]]); ctx.close()

    # ---------- confirmations / reorg awareness
    ctx, pg, ch, errs, inv, ok = pay_flow('index', amount='0.02', node_conf=-1, wait_ms=6000, attrs={'data-confirm-above': '0.01'})
    check('tx in an orphaned block (confirmations -1): NOT paid, shown as seen/confirming', not ok and view(pg) == 'confirming' and events(pg, 'kallubi:seen'), view(pg))
    ch.node_conf = None; ch.phase = 'confirmed'
    ok = wait(pg, PAID, 15000); d = events(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('after a real confirmation on the best chain: paid confirmed:true', ok and d.get('confirmed') is True and d.get('confirmations') == 1, d); ctx.close()

    ctx, pg, ch, errs, inv, ok = pay_flow('index', amount='0.02', node_txindex=False, attrs={'data-fallback': '0', 'data-confirm-above': '0.01'}, wait_ms=6000)
    check('node without txindex, fallback off: seen from mempool', not ok and view(pg) == 'confirming', view(pg))
    ch.phase = 'confirmed'
    ok = wait(pg, PAID, 15000); d = events(pg, 'kallubi:paid')[0]['d'] if ok else {}
    check('node without txindex: confirmation read from address index height + chain tip (no false "dropped")', ok and d.get('confirmed') is True and d.get('confirmations') == 1 and not events(pg, 'kallubi:dropped') and ch.fb_calls == [], [d, ch.fb_calls[:2]]); ctx.close()

    # ---------- no double counting: two buttons, same address, same amount, one tx
    ctx, pg, ch, errs = page('index')
    for wid in ('w1', 'w2'): mount(pg, {'data-to': ADDR, 'data-amount': '0.003', 'data-unique': '0', 'data-poll-ms': '1000'}, wid, clear=(wid == 'w1'))
    click(pg, 'w1'); pg.keyboard.press('Escape'); click(pg, 'w2'); pg.wait_for_timeout(1500)
    ch.pay_sats = 300000; ch.phase = 'mempool'
    wait(pg, PAID, 12000); pg.wait_for_timeout(5000)
    p = events(pg, 'kallubi:paid')
    check('one tx, two identical invoices on the page: exactly ONE paid event', len(p) == 1, [e.get('id') for e in p]); ctx.close()

    # ---------- dropped (double spend / evicted) vs. merely unreachable sources: run both pages side by side
    ctxA, pgA, chA, errsA = page('noindex'); ctxB, pgB, chB, errsB = page('index', browser=b2)   # A: today's production state (node without address index)
    for pg_, ch_ in ((pgA, chA), (pgB, chB)):
        mount(pg_, {'data-to': ADDR, 'data-amount': '0.02', 'data-confirm-above': '0.01', 'data-poll-ms': '1000', 'data-lang': 'de'}); click(pg_); pg_.wait_for_timeout(1500)
        ch_.pay_sats = invoice_sats(pg_); ch_.phase = 'mempool'
    okA = wait(pgA, SEEN, 15000); okB = wait(pgB, SEEN, 15000)
    chA.phase = 'empty'                      # tx vanished everywhere (404 from node and fallback)
    chB.node = 'down'; chB.fb = '500'        # both sources broken, tx may still be fine
    t0 = time.time(); okDrop = wait(pgA, "window.__ev.some(e => e.type === 'kallubi:dropped')", 200000); dt = round(time.time() - t0)
    check('vanished tx (404 everywhere, >= 4 checks, >= 2 min): kallubi:dropped, no paid (%ds)' % dt, okA and okDrop and not events(pgA, 'kallubi:paid') and 100 <= dt <= 200, dt)
    txt = modal_text(pgA)
    check('dropped view in German: "Zahlung nicht bestätigt", retry button', view(pgA) == 'dropped' and 'Zahlung nicht best\u00e4tigt' in txt and 'Erneut versuchen' in txt, txt[:200])
    check('unreachable sources for the same time: still confirming, never dropped', okB and view(pgB) == 'confirming' and not events(pgB, 'kallubi:dropped') and not events(pgB, 'kallubi:paid'), view(pgB))
    check('drop scenario: no JS errors', not errsA and not errsB, errsA + errsB)
    ctxA.close(); ctxB.close()

    # ---------- no third-party names in any UI text, in any language
    ctx, pg, ch, errs = page('index')
    bad = pg.evaluate("""() => { const out = []; KallubiPay.languages.forEach(l => { const s = KallubiPay.util.strings(l);
      Object.keys(s).forEach(k => { if (/whats\\s*on\\s*chain|\\bwoc\\b|taal|gorilla|bitails|jungle/i.test(s[k])) out.push(l + '.' + k); }); }); return out; }""")
    check('UI strings (all languages) name no third-party service', bad == [], bad)

    # ---------- raw tx parser: exact values + fuzz (in the browser, the code that really runs)
    txid0, hx0 = build_tx([(2100000000000000, SCRIPT), (1, SCRIPT), (5, OTHER)])
    r0 = pg.evaluate("([t, h, S]) => KallubiPay.util.verifiedSats(h, t, S)", [txid0, hx0, SCRIPT])
    txid, hx = build_tx([(12345, SCRIPT), (5, OTHER), (55, SCRIPT)])
    r = pg.evaluate("""([txid, hx, S]) => { const u = KallubiPay.util;
      const out = { exact: u.verifiedSats(hx, txid, S), wrongId: u.verifiedSats(hx, '00'.repeat(32), S), odd: u.verifiedSats(hx + '0', txid, S),
        nonhex: u.verifiedSats(hx.slice(0, -2) + 'zz', txid, S), empty: u.verifiedSats('', txid, S), upper: u.verifiedSats(hx.toUpperCase(), txid, S) };
      let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; let thrown = 0, rejected = 0, numbers = 0; const t0 = performance.now();
      for (let i = 0; i < 4000; i++) { let h = hx.split(''); const k = 1 + Math.floor(rnd() * 6);
        for (let j = 0; j < k; j++) h[Math.floor(rnd() * h.length)] = '0123456789abcdef'[Math.floor(rnd() * 16)];
        let s = h.join(''); if (i % 3 === 0) s = s.slice(0, 2 * Math.floor(rnd() * s.length / 2));
        try { u.txOutputs(s); numbers++; } catch (e) { rejected++; }
        try { const v = u.verifiedSats(s, u.txidOf(s) || txid, S); if (v !== null && typeof v !== 'number') thrown += 1e6; } catch (e) { thrown += 1e6; } }
      out.fuzz = { verifiedSatsThrew: thrown, parserRejected: rejected, parsed: numbers, ms: Math.round(performance.now() - t0) }; return out; }""", [txid, hx, SCRIPT])
    check('parser: outputs to the script summing above 21M BSV -> null (no overflow)', r0 is None, r0)
    check('parser: two outputs to the script summed exactly, other address ignored', r['exact'] == 12400, r['exact'])
    txid2, hx2 = build_tx([(2099999999999990, SCRIPT), (1, OTHER), (7, SCRIPT)])
    r2 = pg.evaluate("([t, h, S]) => KallubiPay.util.verifiedSats(h, t, S)", [txid2, hx2, SCRIPT])
    check('parser: 20999999.9999999 BSV + 7 sats summed exactly (integer sats, no float error)', r2 == 2099999999999997, r2)
    check('parser: wrong txid / odd length / non-hex / empty -> null; uppercase hex accepted', r['wrongId'] is None and r['odd'] is None and r['nonhex'] is None and r['empty'] is None and r['upper'] == 12400, r)
    check('parser fuzz: 4000 mutated txs, verifiedSats never throws, bounded time', r['fuzz']['verifiedSatsThrew'] == 0 and r['fuzz']['ms'] < 20000, r['fuzz'])
    ctx.close()
    b.close(); b2.close()

passed = sum(r['ok'] for r in results)
json.dump(results, open('tests/results-node.json', 'w'), indent=1)
print(json.dumps({'passed': passed, 'failed': len(results) - passed}))
sys.exit(0 if passed == len(results) else 1)
