# Changelog

Older versions: see the "Changelog" section in [README.md](README.md).

## 1.3.0 — exact amounts, trusted config, pinned releases

Security hardening.

### Breaking / behaviour changes

- **Exact amount:** a payment counts only if it is **exactly** the invoice amount. More than the amount fires
  `kallubi:overpaid` and shows a note ("more than this invoice … please contact the shop"); it is never reported as
  `kallubi:paid`. The old "at least" rule is available via JS: `acceptOverpay: true`. The same applies to late payments
  and to the check worker (`match=exact` is the default, `match=min` = old rule).
- **Trusted config:** button markup no longer decides where payments are checked, where shipping data goes or which
  function is called. These attributes on the button are **ignored** (console warning): `data-on-paid`, `data-api`,
  `data-node="<url>"`, `data-fallback-url`, `data-broadcaster-url`, `data-quick-ms`, `data-shipping-url`,
  `data-shipping-email`. Use the `<script>` tag (`data-api`, `data-shipping-url`, `data-shipping-email`),
  `window.KallubiPayConfig`, `KallubiPay.config()`, `KallubiPay.mount(el, opts)`, `KallubiPay.onPaid(fn)` or
  `KallubiPay.on(name, fn)`. `data-node=""` and `data-fallback="0"` still work on the button (they only turn sources off).
- **Two rate sources:** fiat prices need two sources that agree within 3 %. If they disagree, or only one answers
  (also with `data-fallback="0"`), there is no QR code. `rateSources: 1` allows one source. Rates outside
  0.5 – 100,000 per BSV are rejected.
- **Shipping address** is no longer inside bubbling page events (`kallubi:shipping`, `kallubi:paid` …); they carry
  `shippingProvided: true`. The full address goes to `KallubiPay.on('shipping')` / `onPaid` callbacks, the shop URL
  and the mail button. `shippingInEvents: true` restores the old events.
- **No baseline, no match:** if the existing transactions of the address cannot be read, nothing is matched; the
  dialog says "Cannot check for payments right now. Retrying…".

### New

- `data-allowed-to` on the script tag: allowlist of payee addresses (wrong address → config error, no QR).
- `data-mount="<selector>"` (auto-mount only inside that container) and `data-auto-mount="0"` (opt-in).
- `KallubiPay.onPaid(fn)` / `KallubiPay.on(name, fn)` return an unsubscribe function. `KallubiPay.config()`.
- `closedShadow: true` (opt-in closed shadow root).
- Versioned, immutable file `/v/1.3.0/button.min.js` with Subresource Integrity (`dist/SRI.json`). `/button.js` keeps
  serving the latest version.
- `package-lock.json` for a reproducible build (`npm ci`).

### Hardening

- Raw transactions above 1 MB are ignored; hashing uses `crypto.subtle`; transactions that pay too little are skipped
  before hashing.
- A payment seen only after a late baseline (> 8 s) is not counted if it was already in the mempool.
- Status fail-closed: if the confirmations / block time of a transaction cannot be read (rate limit, server error,
  HTML instead of JSON, timeout), it is not a match yet; it is checked again on the next poll. This also applies to
  the worker path. The check worker never matches a confirmed transaction without a block time and answers an HTML
  upstream page as an upstream error; `verify/kallubi-verify.mjs` returns `source_error` (`blocktime_unavailable`)
  for a confirmed transaction without a block time.
- `window.KallubiPay` is frozen and not replaceable; the loader ignores HTML elements named `KallubiPay`,
  `KallubiPayConfig` or `currentScript` (DOM clobbering).
- Check worker: rate-limit key salted with the `RL_SALT` secret (random per instance if unset).
- `verify/kallubi-verify.mjs`: `exactSats` is the documented standard; size check before hashing; response bodies
  read with a streaming size cap; RPC / API base URLs must be `https://` (except localhost); `fetchRate()` cross-checks
  two sources (`rate_mismatch`, `single_rate_source`; `minSources: 1` to allow one).

### Roadmap

- Merkle-proof checks for confirmations in the browser.
