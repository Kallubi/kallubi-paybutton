"""Language tests for the Kallubi Pay Button (v1.2.0): data-lang > page lang (<html lang>) > English.
Both chain sources are mocked with Playwright route() (tests/mockchain.py), so this runs offline and deterministic.
Run:  python3 -m http.server 8765 --bind 127.0.0.1 &   then   python tests/test_i18n.py"""
import json, re, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765'
ADDR = '1111111111111111111114oLvT2'
SCRIPT = '76a914' + '00' * 20 + '88ac'
results = []
def check(name, cond, info=''):
    results.append({'test': name, 'ok': bool(cond), 'info': info})
    print(('PASS ' if cond else 'FAIL ') + name + (('  [' + str(info) + ']') if info != '' else ''))

# English words/phrases that must not show up in a German widget (brand words Kallubi/BSV/sats are removed first)
EN = re.compile(r"\b(Pay|Payment|Paid|Waiting|Amount|Copy|Copied|Merchant|Open in wallet|Detected|automatically|Back to shop|Thank|"
                r"Transaction|Seen|Confirmed|confirming|confirmation|Test mode|simulated|demo only|Try again|expired|Close|Time left|"
                r"Powered|Non-custodial|Order|View in|Please|Select|invalid|address|amount|keep this page|network|shop with)\b")
BRAND = re.compile(r'Kallubi Explorer|Kallubi Pay|Kallubi|BSV|sats')

from mockchain import MockChain, is_chain
def Woc(): return MockChain(SCRIPT)

ALLTEXT = """(r) => { const out = []; const w = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) { if (n.nodeType === 3) { if (!n.parentElement.closest('.mono,.a,style')) out.push(n.nodeValue); }
    else { ['aria-label', 'title'].forEach(a => { if (n.hasAttribute && n.hasAttribute(a) && !n.closest('.mono,.a')) out.push(n.getAttribute(a)); }); } }
  return out.join(' | '); }"""
def modal_text(pg): return pg.evaluate("(f) => { const h = document.querySelector('[data-kallubi-modal]'); return h ? (eval(f))(h.shadowRoot) : ''; }", ALLTEXT)
def btn_text(pg, sel='#w'): return pg.evaluate("(f) => (eval(f[0]))(document.querySelector(f[1] + ' .kallubi-pay-host').shadowRoot)", [ALLTEXT, sel])
def leftovers(txt):
    t = re.sub(r'data-[a-z-]+', ' ', BRAND.sub(' ', txt))   # attribute names like data-amount are code, not text
    return sorted(set(m.group(0) for m in EN.finditer(t)))
def view(pg): return pg.evaluate("(() => { const h = document.querySelector('[data-kallubi-modal]'); const d = h && h.shadowRoot.querySelector('.modal'); return d && d.getAttribute('data-view'); })()")
def mtext(pg, sel): return pg.evaluate("(s) => { const h = document.querySelector('[data-kallubi-modal]'); const n = h && h.shadowRoot.querySelector(s); return n && n.textContent; }", sel)
def wait(pg, js, ms):
    try: pg.wait_for_function(js, timeout=ms); return True
    except Exception: return False
def W(v): return "(() => { const h = document.querySelector('[data-kallubi-modal]'); return h && h.shadowRoot.querySelector('.modal').dataset.view === '%s'; })()" % v
def mount(pg, attrs, html_lang=None):
    pg.evaluate("""([a, l]) => { if (l === null) {} else if (l === '') document.documentElement.removeAttribute('lang'); else document.documentElement.setAttribute('lang', l);
      const s = document.getElementById('slot'); s.textContent = ''; const d = document.createElement('div');
      d.setAttribute('data-kallubi-pay', ''); d.id = 'w'; const T = {'data-node': 'node', 'data-api': 'api', 'data-quick-ms': 'quickMs', 'data-fallback-url': 'fallbackUrl', 'data-broadcaster-url': 'broadcasterUrl', 'data-shipping-url': 'shippingUrl', 'data-shipping-email': 'shippingEmail'}; const o = Object.assign({}, a.__opts || {}); let use = !!a.__opts; for (const k in a) { if (k === '__opts') continue; if (T[k] && !(k === 'data-node' && a[k] === '')) { o[T[k]] = a[k]; use = true; } else d.setAttribute(k, a[k]); } if ('data-shipping' in a && !('shippingInEvents' in o)) { o.shippingInEvents = true; use = true; } if (use) KallubiPay.mount(d, o); s.appendChild(d); /* v1.3.0: trusted settings via KallubiPay.mount options */ }""", [attrs, html_lang])
    pg.wait_for_function("document.querySelector('#w .kallubi-pay-host')")
def click(pg): pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').click()")
def close(pg): pg.keyboard.press('Escape')
T = {'data-to': ADDR, 'data-amount': '0.0005', 'data-test': '1', 'data-test-delay': '60000', 'data-theme': 'dark'}

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome')
    def page(url='/tests/blank.html', locale='en-US'):
        ctx = b.new_context(viewport={'width': 1100, 'height': 900}, locale=locale); woc = Woc()
        woc.route_all(ctx)
        pg = ctx.new_page(); errs = []; warns = []; ext = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: m.type == 'warning' and warns.append(m.text))
        pg.on('request', lambda r: (not r.url.startswith(BASE)) and ext.append(r.url))
        pg.goto(BASE + url); pg.wait_for_function('window.KallubiPay')
        return ctx, pg, woc, errs, warns, ext

    # ---- dictionary + unit
    ctx, pg, woc, errs, warns, ext = page()
    info = pg.evaluate("""() => { const K = KallubiPay, en = K.util.strings('en'); const ph = s => (s.match(/\\{\\w+\\}/g) || []).sort().join();
      const bad = []; K.languages.forEach(l => { const d = K.util.strings(l); Object.keys(en).forEach(k => { if (!d[k] || ph(d[k]) !== ph(en[k])) bad.push(l + '.' + k); });
        Object.keys(d).forEach(k => { if (!(k in en)) bad.push(l + '.' + k + '(extra)'); }); });
      return {version: K.version, langs: K.languages, keys: Object.keys(en).length, bad}; }""")
    check('i18n: version 1.3.0, languages en/de/es/fr/it/pt', info['version'] == '1.3.0' and info['langs'] == ['en', 'de', 'es', 'fr', 'it', 'pt'], [info['version'], info['langs']])
    check('i18n: every language has every key with the same {placeholders}', not info['bad'] and info['keys'] >= 45, [info['keys'], info['bad'][:5]])
    nl = pg.evaluate("['de','DE','de-AT','pt_BR',' fr ','it-IT','english','deutsch','xx','zh-CN','','auto',null].map(KallubiPay.util.normLang)")
    check('i18n: normLang ("de-AT" -> de, unknown -> null)', nl == ['de', 'de', 'de', 'pt', 'fr', 'it', None, None, None, None, None, None, None], nl)

    # ---- language selection
    cases = [
        ('data-lang="de" on an English page', {'data-lang': 'de'}, 'en', 'Mit BSV bezahlen'),
        ('data-lang="DE-ch" (case / region ignored)', {'data-lang': 'DE-ch'}, 'en', 'Mit BSV bezahlen'),
        ('page <html lang="fr-FR">, no data-lang', {}, 'fr-FR', 'Payer avec BSV'),
        ('data-lang="auto" follows <html lang="it">', {'data-lang': 'auto'}, 'it', 'Paga con BSV'),
        ('data-lang wins over <html lang> (es on a de page)', {'data-lang': 'es'}, 'de', 'Pagar con BSV'),
        ('<html lang="pt-BR">', {}, 'pt-BR', 'Pagar com BSV'),
        ('unknown data-lang="xx" -> English (even on a de page)', {'data-lang': 'xx'}, 'de', 'Pay with BSV'),
        ('unknown <html lang="zh-CN"> -> English', {}, 'zh-CN', 'Pay with BSV'),
        ('no lang anywhere -> English', {}, '', 'Pay with BSV'),
    ]
    for name, attrs, hl, want in cases:
        mount(pg, dict({'data-to': ADDR, 'data-amount': '0.0005'}, **attrs), hl)
        got = pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').textContent")
        check('lang: ' + name, got.endswith(want), got)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-lang': 'de', 'data-button-text': 'Jetzt kaufen'}, 'en')
    got = pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').textContent")
    check('lang: data-button-text still overrides the button text', got.endswith('Jetzt kaufen'), got)
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005', 'data-lang': 'fr', 'data-show-amount': '1'}, 'en')
    got = pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').textContent")
    check('lang: data-show-amount translated, amount keeps the dot (fr)', got.endswith('Payer 0.0005 BSV'), got)
    ctx.close()

    # ---- visitor browser language is NOT used (shop decides)
    ctx, pg, woc, errs, warns, ext = page(locale='de-DE')
    mount(pg, {'data-to': ADDR, 'data-amount': '0.0005'}, 'en')
    got = pg.evaluate("[navigator.language, document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('button').textContent]")
    check('lang: German browser on an English shop page stays English', got[0].startswith('de') and got[1].endswith('Pay with BSV'), got)
    ctx.close()

    # ---- static page with <html lang="de-AT">: German, lang attribute set on the widget for screen readers
    ctx, pg, woc, errs, warns, ext = page('/tests/lang-de.html')
    pg.wait_for_function("document.querySelector('#w .kallubi-pay-host')")
    bt = btn_text(pg)
    rl = pg.evaluate("document.querySelector('#w .kallubi-pay-host').shadowRoot.querySelector('.root').getAttribute('lang')")
    check('static <html lang="de-AT">: button + "Bereitgestellt von" in German, lang="de" on the widget', 'Mit BSV bezahlen' in bt and 'Bereitgestellt von' in bt and rl == 'de' and not leftovers(bt), [bt, rl])
    click(pg); pg.wait_for_function(W('waiting'))
    mt = modal_text(pg)
    ol = pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.ov').getAttribute('lang')")
    check('static de page: waiting dialog fully German, lang="de" on the dialog', not leftovers(mt) and 'Warte auf Zahlung' in mt and ol == 'de', leftovers(mt) or mt[:120])
    ctx.close()

    # ---- de mode: no English leftovers in all main states (test mode)
    ctx, pg, woc, errs, warns, ext = page()
    mount(pg, dict(T, **{'data-lang': 'de', 'data-merchant': 'Testladen', 'data-order': 'A-1', 'data-label': 'Kapuzenpulli'}), 'en')
    bt = btn_text(pg)
    check('de: button area has no English leftovers', not leftovers(bt), [bt, leftovers(bt)])
    click(pg); pg.wait_for_function(W('waiting'))
    mt = modal_text(pg)
    sats = mtext(pg, '.amt .sats'); amt = pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('[data-amount]').textContent")
    check('de waiting (test mode): no English leftovers', not leftovers(mt), leftovers(mt))
    check('de waiting: title, test note, timer label in German', 'Bei Testladen bezahlen' in mt and 'Bestellung #A-1' in mt and 'Testmodus' in mt and 'Verbleibende Zeit' in mt, mt[:160])
    check('de waiting: BSV amount keeps the dot, sats use a narrow space (no "," that reads as decimal comma)', re.fullmatch(r'0\.0005\d{1,4}BSV', amt) and re.fullmatch('= 50\u202f0\\d\\d sats', sats), [amt, sats])
    pg.context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('.copy').click()"); pg.wait_for_timeout(300)
    check('de: copy button says "Kopiert"', mtext(pg, '.copy span') == 'Kopiert', mtext(pg, '.copy span'))
    close(pg)
    # expired
    mount(pg, dict(T, **{'data-lang': 'de', 'data-ttl': '3'}), 'en'); click(pg)
    ok = wait(pg, W('expired'), 8000); mt = modal_text(pg)
    check('de expired: no English leftovers', ok and not leftovers(mt) and 'Zahlungszeit abgelaufen' in mt and 'Erneut versuchen' in mt, leftovers(mt) or mt[:120])
    close(pg)
    # confirming -> paid (test mode, threshold 0)
    mount(pg, dict(T, **{'data-lang': 'de', 'data-merchant': 'Testladen', 'data-confirm-above': '0', 'data-test-delay': '600', 'data-test-confirm-delay': '2500'}), 'en'); click(pg)
    ok = wait(pg, W('confirming'), 6000); mt = modal_text(pg); bt = btn_text(pg)
    check('de confirming (test mode): no English leftovers in dialog + button', ok and not leftovers(mt) and not leftovers(bt) and 'warte auf 1 Bestätigung' in mt, leftovers(mt + bt) or mt[:120])
    ok = wait(pg, W('paid'), 8000); mt = modal_text(pg); bt = btn_text(pg)
    check('de paid (test mode): no English leftovers in dialog + button', ok and not leftovers(mt) and not leftovers(bt) and 'Zahlung erhalten' in mt and 'Bezahlt' in bt, leftovers(mt + bt) or mt[:120])
    check('de paid: status pill "Testmodus · simuliert · 1 Bestät."', mtext(pg, '.pill') == 'Testmodus · simuliert · 1 Bestät.', mtext(pg, '.pill'))
    close(pg)
    # config error
    warns.clear()
    mount(pg, {'data-to': 'nope', 'data-amount': 'x', 'data-lang': 'de'}, 'en'); pg.wait_for_timeout(200)
    et = btn_text(pg)
    check('de error: config errors in German, console warning stays English', not leftovers(et) and 'ungültige BSV-Adresse' in et and any('invalid BSV address' in w for w in warns), [et[:100], warns[-1:]])
    check('de test mode: no network requests, no JS errors', not ext and not errs, [ext[:3], errs])
    ctx.close()

    # ---- de mode, real (mocked WoC): waiting / seen-confirming / paid texts
    ctx, pg, woc, errs, warns, ext = page()
    mount(pg, {'data-to': ADDR, 'data-amount': '0.02', 'data-confirm-above': '0.01', 'data-lang': 'de', 'data-merchant': 'Testladen', 'data-poll-ms': '1000', 'data-theme': 'dark'}, 'en'); click(pg)
    pg.wait_for_function(W('waiting')); pg.wait_for_timeout(1500)
    mt = modal_text(pg)
    check('de waiting (real mode): no English leftovers, "Wird automatisch erkannt"', not leftovers(mt) and 'Wird automatisch erkannt' in mt, leftovers(mt))
    woc.pay_sats = round(float(pg.evaluate("document.querySelector('[data-kallubi-modal]').shadowRoot.querySelector('[data-amount]').getAttribute('data-amount')")) * 1e8)
    woc.phase = 'mempool'
    ok = wait(pg, W('confirming'), 15000); mt = modal_text(pg); bt = btn_text(pg)
    check('de seen/confirming (real mode, 0.02 BSV with data-confirm-above=0.01): German, no English leftovers', ok and not leftovers(mt) and not leftovers(bt) and 'Deine Zahlung ist sicher' in mt and 'Erkannt · 0 / 1 Bestät.' in mt, leftovers(mt + bt) or mt[:140])
    woc.phase = 'confirmed'
    ok = wait(pg, W('paid'), 20000); mt = modal_text(pg)
    check('de paid (real mode): "Bestätigt · 1 Bestät.", no English leftovers', ok and not leftovers(mt) and mtext(pg, '.pill') == 'Bestätigt · 1 Bestät.', leftovers(mt) or mtext(pg, '.pill'))
    check('de real mode: no JS errors, only the chain sources contacted', not errs and all(is_chain(u) for u in ext) and len(woc.calls) > 0, errs)
    ctx.close()

    # ---- es / fr / it / pt smoke: waiting dialog texts come from the dictionary
    ctx, pg, woc, errs, warns, ext = page()
    want = {'es': 'Esperando el pago…', 'fr': 'En attente du paiement…', 'it': 'In attesa del pagamento…', 'pt': 'Aguardando pagamento…', 'en': 'Waiting for payment…'}
    for l, w1 in want.items():
        mount(pg, dict(T, **{'data-lang': l}), 'en'); click(pg); pg.wait_for_function(W('waiting'))
        got = [mtext(pg, '.w1'), mtext(pg, '.amt .k'), mtext(pg, 'a.btn.gold')]
        check('%s waiting dialog' % l, got[0] == w1 and got[1] and got[2], got)
        close(pg)
    check('es/fr/it/pt: no JS errors', not errs, errs)
    ctx.close()
    b.close()

passed = sum(r['ok'] for r in results)
print(json.dumps({'passed': passed, 'failed': len(results) - passed}))
json.dump(results, open('tests/results-i18n.json', 'w'), indent=1, ensure_ascii=False)
sys.exit(0 if passed == len(results) else 1)
