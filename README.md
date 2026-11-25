# Kallubi Pay Button · v1.2.0

A drop-in **"Pay with BSV"** button for any website. One `<script>` tag, one `<div>`.
The buyer pays **straight to the merchant's own BSV address**. Kallubi never holds funds:
no keys, no seeds, no accounts, no custody, no cookies, no tracking.


## Disclaimer

This software is provided **"as is", without warranty of any kind** (Apache-2.0, sections 7 and 8). You use it **at your
own risk and responsibility**. Kallubi **never has access to funds**: buyers pay straight to the merchant's address,
Kallubi holds no keys and receives nothing. A payment without a block confirmation (0-conf) is **never 100 % safe**: a
double-spend can still appear after the quick check. Each shop decides when to ship and must verify every payment on its
own server (see [Verify payments on your server](#verify-payments-on-your-server-required)). Nothing here is financial,
legal or tax advice. German guide: [ANLEITUNG-DE.md](ANLEITUNG-DE.md).

## Embed

```html
<script src="https://pay.kallubi-bsv-explorer.de/button.js" defer></script>

<div data-kallubi-pay
     data-to="1YourOwnBsvAddress..."
     data-amount="0.0005"
     data-label="Basic T-Shirt"
     data-theme="auto"></div>
```

The button is also presented, with a live demo and an embed-code generator, in the **Pay Button** tab of the
Kallubi Explorer (`https://kallubi-bsv-explorer.de/?tool=paybutton`). `pay.kallubi-bsv-explorer.de` only serves the script file.

| attribute | required | values / meaning |
|---|---|---|
| `data-to` | yes | your **mainnet P2PKH** address (`1…`). Checked with base58check (checksum) in the browser. A testnet/STN address or a P2SH address (`3…`) is rejected with a specific error, not a generic "invalid" message. |
| `data-amount` | yes | price in BSV, max 8 decimals (`0.0005` = 50,000 sats). At least 1 satoshi, at most 21000000 BSV. |
| `data-label` | – | product / reason, shown in the dialog and put into the `bitcoin:` URI |
| `data-merchant` | – | shop name ("Pay Example Shop") |
| `data-order-id` | – | **v1.2.0** your order id: 1–64 characters, letters, digits and `. _ - : / #` (anything else is a config error, so it is always safe in events, e-mails and POSTs). Returned as `orderId` in every event. Without it, a random `kp-…` reference is generated per payment (`orderIdGenerated: true`) |
| `data-order` | – | older free-text order id (≤ 40 chars), still supported and returned as `order`. Prefer `data-order-id` |
| `data-theme` | – | `light`, `dark` or `auto` (default; follows the visitor's light/dark setting) |
| `data-style` | – | `outline` for the outline button (default: gold filled) |
| `data-size` | – | `sm` for the small button |
| `data-show-amount` | – | `1` → button text "Pay 0.0005 BSV" |
| `data-button-text` | – | custom button text (used as-is in every language) |
| `data-lang` | – | `en`, `de`, `es`, `fr`, `it`, `pt` or `auto` (default). `auto` = language of the page (`<html lang="…">`), otherwise English. Unknown codes → English. See below |
| `data-amount-fiat` | – | **v1.2.0** price in EUR or USD instead of `data-amount`, e.g. `25.00` (dot, max 2 decimals, 0.01 – 1,000,000.00). Converted to BSV at the current rate when the buyer opens the dialog. See "Fiat prices" |
| `data-currency` | – | `EUR` or `USD` together with `data-amount-fiat`. Without `data-amount-fiat` only `BSV` (anything else shows a config error) |
| `data-unique` | – | `0` turns the unique sats tag off (default **on**, see below) |
| `data-expires-min` | – | **v1.2.0** payment window in whole minutes, 1–60 (default 15). Wins over `data-ttl` |
| `data-ttl` | – | older form: payment window in seconds (default 900 = 15 min) |
| `data-confirm-above` | – | Optional BSV override: amount in BSV from which a payment needs **1 block confirmation**. `0` = always wait. Cannot be combined with `data-confirm-above-fiat`. If omitted, the EUR line below applies (converted with the rate). |
| `data-confirm-above-fiat` | – | EUR amount (not the button currency). Prices **above** this line need **1 block confirmation**. Default **`200`**. `0` = always wait. USD is converted from this EUR amount with the ECB rate; BSV prices convert it with the EUR/BSV rate. Without a valid rate the button waits. |
| `data-api` | – | URL of the optional check worker (`https://…/api/pay/check`). Empty = direct detection (own node first, see below). The worker's answer is only a hint: amount and confirmations are re-checked from the raw tx via `data-node` / the fallback (with both turned off, a worker answer is never accepted) |
| `data-node` | – | advanced: base URL of the Kallubi node API (default `https://node.kallubi-bsv-explorer.de/v1/bsv/main`; `""` = do not use it) |
| `data-fallback` | – | `0` = never use the public fallback source (detection then depends on the own node only). Default on |
| `data-on-paid` | – | name of a global function, e.g. `myShop.onPaid` (looked up by name, never `eval`ed) |
| `data-test` | – | `1` = **test mode**: no chain requests, simulated payment (with `data-amount-fiat` the real rate is still loaded) after ~8 s (`data-test-delay` ms); a simulated confirmation follows after `data-test-confirm-delay` ms (default 8000) when the amount is at/above `data-confirm-above` |
| `data-shipping` | – | `1` = ask the buyer for a **shipping address** before the QR step (default off). The address goes **only to the merchant**, never to Kallubi. See "Shipping address" below |
| `data-shipping-url` | – | only with `data-shipping="1"`: **your own HTTPS endpoint**. The buyer's browser POSTs the address + txid there as JSON once the payment is seen. Must allow CORS. `http://` is only accepted for `localhost` (dev) |
| `data-shipping-email` | – | only with `data-shipping="1"`: your shop email. After payment the buyer gets an "Email address to the shop ✉" button (opens *their* mail app with address + txid filled in). Also used as a fallback if the URL fails |
| `data-poll-ms` | – | advanced: poll interval in ms (default 5000, min 1000). Leave it alone in production |

### Languages (`data-lang`)

All texts of the button and the dialog (statuses, errors, test-mode notes, aria labels) are available in
**English (default), German, Spanish, French, Italian and Portuguese**. The language is chosen like this:

1. `data-lang="de"` on the `<div>` (region suffixes are ignored: `de-AT` → `de`). `data-lang="auto"` = step 2.
2. otherwise the language of the **shop page**: the nearest `lang` attribute, normally `<html lang="fr">`.
3. otherwise, or for an unsupported code (e.g. `zh`), **English**.

The visitor's browser language (`navigator.language`) is deliberately **not** used: the shop decides, so the
button always matches the language of the page around it. Brand words (Kallubi, BSV, sats) are not translated.
Amounts are **not localised**: BSV amounts always use a dot (`0.00050037`), like in wallets and in the QR code,
so a buyer never confuses a decimal comma with a thousands separator. Only the sats line uses a neutral narrow
space as thousands separator outside English (`50 037 sats` instead of `50,037`). Config errors are shown in the
page language; the console warning for developers stays English.

```html
<div data-kallubi-pay data-to="1…" data-amount="0.0005" data-lang="de"></div>   <!-- "Mit BSV bezahlen" -->
```


### Getting notified

```js
document.addEventListener('kallubi:paid', (e) => {
  // e.detail = { txid, amount: "0.00050037", sats: 50037, requestedSats: 50037, to, order, test,
  //              confirmed: false, confirmations: 0, confirmationRequired: false, confirmAboveSats: 1000000 }
});
document.addEventListener('kallubi:seen', (e) => {
  // only for amounts >= data-confirm-above: the tx is in the mempool, kallubi:paid follows after 1 confirmation
});
```

The event bubbles from your `<div>` (also through shadow roots).

> **Important: browser events are UX only.** `kallubi:paid` and `data-on-paid` run in the buyer's browser.
> Anyone can fire them with made-up data from the developer console. **Never ship goods because of a browser event.**
> Send `{ orderId, txid }` to your server and decide there, from the blockchain. See "Verify payments on your server" below.

v1.2.0 adds these fields to every event (existing fields are unchanged):
`orderId`, `orderIdGenerated`, `tag` (unique sats tag), `createdAt` / `expiresAt` (Unix seconds),
`serverVerify: "required"`, and with `data-amount-fiat` also
`fiat: { amount: "25.00", currency: "EUR", rate: "12.67", rateTime, rateSource, quotedSats }`.

New events in v1.2.0:

| event | when |
|---|---|
| `kallubi:expired` | the payment window ended without a payment. The QR is withdrawn |
| `kallubi:late` | a matching payment was found **after** the window ended (`late: true`, `expiredAt`). It is **not** reported as `kallubi:paid`. The buyer is told not to pay again and to contact you. Decide on your server (refund, accept, or ask for the difference) |

## Fiat prices (`data-amount-fiat`, v1.2.0)

```html
<div data-kallubi-pay data-to="1YourOwnBsvAddress..." data-amount-fiat="25.00" data-currency="EUR"
     data-order-id="ORDER-1042" data-expires-min="15"></div>
```

- When the buyer opens the dialog, the button loads the current rate: **CoinGecko (EUR and USD) first**. Backup if
  CoinGecko fails: **USD = WhatsOnChain; EUR = WhatsOnChain USD rate ÷ official ECB EUR/USD reference rate.**
- The dialog always says where the rate came from ("Rate source: CoinGecko", or
  "Rate source: WhatsOnChain (USD) × ECB EUR/USD 1.0963 (2026-11-24)"). Events carry the same facts in `fiat.rateSource`
  (`coingecko`, `whatsonchain`, `whatsonchain+ecb`) and, for the backup, `fiat.usdRate`, `fiat.ecbRate`, `fiat.ecbDate`.
- The BSV amount is **rounded up** to the next whole satoshi, so you never receive less than your price. The exact
  calculation uses integers: `sats = ceil(cents × 10^12 / rate_in_micro_units)`.
- The dialog shows the price, the rate and the time of the rate. The amount stays fixed until the timer runs out.
  After that, "Try again" fetches a new rate.
- **No fresh rate means no QR code.** If the rate is missing, zero, unreadable, older than 10 minutes or dated in the
  future, the buyer sees "Exchange rate unavailable" and a retry button. There is no payment request based on an old or zero rate.
- The ECB publishes its reference rate once per working day (around 16:00 CET). The button accepts an ECB rate that is
  at most 5 calendar days old (weekends and Easter/Christmas closures), never one dated in the future, and only between
  0.5 and 2.0 USD per EUR. A good ECB answer is kept for 1 hour. The BSV rate itself (WhatsOnChain) must still be at
  most 10 minutes old. If anything is missing: no QR code.
- Why the ECB Data Portal in the browser: the ECB daily XML file cannot be read by a browser on another website (the ECB
  server does not allow it). The official ECB Data Portal (`data-api.ecb.europa.eu`) publishes the **same** reference rate
  and allows it. The server helper (`kallubi-verify.mjs`) reads the daily XML directly.
- `data-fallback="0"` also switches the rate backup off (CoinGecko only).
- Privacy: in fiat mode the buyer's browser also contacts `api.coingecko.com`, and only if that fails
  `api.whatsonchain.com` and `data-api.ecb.europa.eu` (no cookies, no referrer).
- Confirmations for fiat prices: see "0-conf or 1 confirmation" below (default: up to 20.00 at 0-conf).

## Payment window and late payments (v1.2.0)

- Default 15 minutes (`data-expires-min`, 1–60). A countdown and a progress bar are shown.
- When the time runs out, the QR code is removed and `kallubi:expired` fires.
- The button keeps looking for a payment for another 30 minutes (slowly, every 15 s). If one arrives, the buyer sees
  "Payment arrived too late" and you get `kallubi:late`. Such a payment is never reported as paid. Opening the button
  again shows the same notice, never a new QR code, so the buyer is not asked to pay twice.
- A payment found at or after the deadline counts as late. Your server should apply the same rule with `expiresAt`.

## Verify payments on your server (required)

The browser cannot prove a payment. Your server can, without trusting Kallubi or the buyer.
`verify/kallubi-verify.mjs` does it with no dependencies (Node 18+), no keys and no secrets:

1. It downloads the **raw transaction** (from WhatsOnChain or your own BSV node via RPC) and checks that its
   double-SHA256 equals the txid. Amounts are parsed from these raw bytes, never taken from someone's JSON.
2. It adds up the outputs that pay **your** address and compares them with the amount **your server** expects.
3. It rejects payments older than the order, can require confirmations, and reports payments it first sees after
   `expiresAt` as `late`.
4. **Replay protection:** one txid can pay one order only. You pass a `claims` store (in production a database table
   with `UNIQUE(txid)`).

### Level 2 (recommended): your server sets the exact amount

The server creates the quote. It adds a random tag that no other open order has, renders the button with that exact
BSV amount, and later requires exactly that amount. A stranger's payment can then never be claimed for another order.

```js
import { fetchRate, createQuote, verifyPayment } from './kallubi-verify.mjs';

// 1. order page
const r = await fetchRate('EUR');                                   // fresh rate on YOUR server
const q = createQuote({ cents: 2500, rate: r.rate, currency: 'EUR', expiresMin: 15, openSats: await db.openAmounts() });
await db.saveOrder({ id: 'ORDER-1042', sats: q.sats, createdAt: q.createdAt, expiresAt: q.expiresAt });
// render: <div data-kallubi-pay data-to="1Your…" data-amount="${q.amountBsv}" data-unique="0"
//              data-order-id="ORDER-1042" data-expires-min="15"></div>

// 2. the page posts { orderId, txid } from kallubi:paid to your server
const o = await db.getOrder(orderId);
const res = await verifyPayment({ txid, orderId: o.id, address: '1Your…', exactSats: o.sats, orderCents: 2500,
  createdAt: o.createdAt, expiresAt: o.expiresAt, claims: db.claims });   // > 20.00: 'pending' until 1 confirmation
if (res.ok) await db.markPaid(o.id, txid);          // only then ship
```

### Level 1 (simple): the button converts in the browser

With `data-amount-fiat` the browser computes the amount. Your server must **not** trust that number. Compute the
minimum yourself from your own price and a rate your server fetched:

```js
import { fetchRate, minSatsFromFiat, verifyPayment } from './kallubi-verify.mjs';
const r = await fetchRate('EUR');
const res = await verifyPayment({ txid, orderId, address: '1Your…', minSats: minSatsFromFiat(2500, r.rate, 2), orderCents: 2500,
  createdAt: order.createdAt, expiresAt: order.createdAt + 15 * 60, claims: db.claims });
```

Level 1 is weaker: if two orders have the same price, someone could try to claim another buyer's payment first.
Use Level 2 for anything that matters.

### Results

`res.status` is one of `paid` (only this means ship), `pending` (not enough confirmations or not indexed yet, ask
again), `underpaid`, `overpaid` (exact mode, review by hand), `late`, `too_old`, `already_used`, `txid_mismatch`,
`bad_tx`, `not_found`, `source_error`, `bad_input`.

### Your own node

```js
verifyPayment({ ..., source: { rpc: { url: process.env.BSV_RPC_URL, user: process.env.BSV_RPC_USER, password: process.env.BSV_RPC_PASS } } })
```

Keep RPC credentials in environment variables on your server. Never put them in the page. With WhatsOnChain the amounts
are still verified from the raw bytes, but whether a tx exists or is confirmed is reported by that service. For high
amounts, use your own node or `minConfirmations: 1`. If the status lookup fails, the check fails closed (`source_error`).

### Why no webhook from Kallubi?

Kallubi does not touch other people's money or data. A webhook from Kallubi would make Kallubi a party you have to
trust, and it would need your shop secret on Kallubi's servers. Checking the transaction yourself is stronger and needs
no secret at all. There is no Kallubi webhook, and none is planned.

### 0-conf or 1 confirmation (`data-confirm-above-fiat`, `data-confirm-above`)

Kallubi policy: **with a passed quick check, prices up to 200.00 EUR are accepted as soon as the payment is seen
(typically a few seconds). Above that the button waits for 1 block confirmation (~10 min).**

The quick check (not used in test mode) requires all of the following:

1. The payment is seen on **your own Kallubi BSV node** (raw hex verified there).
2. The same transaction is submitted to **BSV Broadcaster** (the official successor to ARC; public endpoints, no API key,
   CORS `*`) and reaches `SEEN_ON_NETWORK`, `MINED` or `IMMUTABLE` with no `competingTxs`.
3. A **5 second** observation window (3–5 s) in which Broadcaster must not report `DOUBLE_SPEND_ATTEMPTED`.
4. The transaction is **final**: every input has `nSequence = 0xffffffff` (or `nLockTime` is 0 / already passed).
5. The fee is at least the Broadcaster policy rate (currently 100 sat/kB; `GET /policy`).

If the quick check is **unavailable** (no node, Broadcaster unreachable, parent transactions missing so the fee cannot
be computed): 0-conf is only used **up to 20.00 EUR**, the previous line. Above that the button waits for 1 confirmation.
A non-final transaction always waits, even below 20 EUR (checked locally on the raw tx). A failed check (low fee or a
reported double-spend) always waits too. Below the 20 EUR fallback the Broadcaster check is not run.

- `data-confirm-above-fiat` is an **EUR** amount, default **`200`**. `0` = always wait for 1 confirmation.
- **USD** prices convert that EUR amount with the official ECB USD/EUR reference rate (same rules as the EUR backup:
  max 5 days old, 0.5–2.0, 1 h cache), floored so the line is never above 200 EUR. Without a valid ECB rate the button
  waits. The applied USD line is in `confirmAboveApplied` (e.g. `"219.26"` when the ECB rate is 1.0963).
- **BSV** prices convert the same EUR line with the EUR/BSV rate, floored. Without a valid rate the button waits.
  An explicit `data-confirm-above` (BSV) remains a shop override and needs no rate; it cannot be combined with
  `data-confirm-above-fiat`.
- Events: `confirmationRequired`, `confirmAboveFiat` (the configured EUR amount, e.g. `"200.00"`),
  `confirmAboveApplied` (fiat, in the button currency), `confirmAboveSats` (when the line is in sats), and
  `quickCheck` (`ok`, `txStatus`, `reason`) when a check was run.
- Your server applies the same policy: `verifyPayment({ ..., orderCents: 2500 })` is 0-conf only up to the 20.00 EUR
  fallback unless you pass `quickCheck: 'run'` (and, for USD, `currency: 'USD', usdPerEur`): then your server runs the
  same quick check itself (final tx, fee from hash-checked parents, re-submit to BSV Broadcaster, 5 s window, no
  `competingTxs`). **Never pass the `quickCheck` from the browser event**: the buyer controls the browser and can fake
  it. The helper only accepts results made by `runQuickCheck()` on your server; anything else is `bad_input`. The default
  `zeroConfUpToCents` is 20000 (200.00 EUR). For BSV-priced orders pass `eurRate` or an explicit `confirmFromSats`.
  Without a rate the helper waits. `minConfirmations` can only make this stricter. A non-final transaction is never
  accepted at 0-conf. `requiredConfirmations({ cents, currency, usdPerEur, eurRate, quickCheck })` gives the number
  on its own.
- **Residual risk (honest):** 0-conf is never 100 % safe. A competing double-spend can still appear after the 5 s
  window. Broadcaster only tracks transactions submitted to that endpoint (the button re-submits the already-seen
  raw payment; if every endpoint refuses it, the check is treated as unavailable). The shop must still decide "paid"
  on its own server with `verify/kallubi-verify.mjs`, never from the browser event alone. Wait for 1 confirmation
  when the amount or the risk is high.

| invoice | what the buyer sees | event |
|---|---|---|
| up to 20.00 EUR, or up to 200.00 EUR with a passed quick check | "Payment received ✓ · Seen on network" (quick check: a short "Checking the payment" step first) | `kallubi:paid` with `confirmed:false, confirmations:0` |
| above the line, or mid-range with no quick check, or a failed check | "Payment seen – waiting for 1 confirmation (~10 min)" (gold, elapsed timer), then "Payment received ✓ · Confirmed" | `kallubi:seen` first, then `kallubi:paid` with `confirmed:true, confirmations:1` |

Once a payment is seen, the 15 min countdown stops: a seen payment can never expire. The widget keeps checking
the tx (every 15 s, every 30 s in background tabs, up to 6 h) until it has 1 confirmation. If the tx is already
confirmed when it is first found, `kallubi:paid` fires right away with `confirmed:true`.


## Shipping address (optional)

For shops without a shop system (e.g. a small merch seller on X) the widget can ask for a delivery address:

```html
<div data-kallubi-pay data-to="1…" data-amount="0.0005" data-label="Hoodie" data-merchant="Merch Shop"
     data-shipping="1"
     data-shipping-url="https://merch-shop.example/api/orders"
     data-shipping-email="orders@merch-shop.example"></div>
```

Flow: button → **form** (name, street + number, postal code, city, country, optional email, optional note; required fields
are validated, all 6 languages) → QR step (the "Ship to" line has an *Edit* link) → paid. The invoice and the chain
polling only start after the form is sent. Off by default: without `data-shipping` the widget opens the payment QR immediately.

**Privacy design: Kallubi never sees the address.**

- The address lives only in the widget's memory for this page session. No cookies, no localStorage, no Kallubi server.
- It reaches the merchant in up to three ways, all of them chosen by the merchant:
  1. **Page events** (for shops with their own JS): `kallubi:shipping` when the form is sent, and `shipping` inside
     the `kallubi:seen` / `kallubi:paid` detail.
  2. **`data-shipping-url`**: the buyer's browser POSTs JSON **directly** to that URL when the payment is first seen.
     Sent with `credentials:'omit'`, `referrerPolicy:'no-referrer'`, `redirect:'error'` (the data cannot be bounced to another host), 15 s timeout.
     Result: `kallubi:shipping-sent` `{ok, status, txid, order, test}`.
  3. **`data-shipping-email`**: a `mailto:` button. The widget sends nothing; the buyer's own mail app opens and the buyer presses send.
- The form shows "🔒 Your address goes only to <merchant>, never to Kallubi." plus the receiving host when a URL is set.
- Kallubi's explorer generator preview never sets a URL, so nothing is posted from Kallubi's page.

POST body:

```json
{ "kallubi": "shipping", "version": "1.0.0", "txid": "…64 hex…", "amount": "0.00050037", "sats": 50037,
  "requestedSats": 50037, "tag": 37, "to": "1…", "order": "MS-7", "label": "Hoodie", "merchant": "Merch Shop",
  "test": false, "confirmed": false, "confirmations": 0,
  "shipping": { "name": "…", "street": "…", "postalCode": "…", "city": "…", "country": "…", "email": "…", "note": "…" } }
```

The endpoint must answer the CORS preflight (`Access-Control-Allow-Origin` = your shop origin or `*`,
`Access-Control-Allow-Headers: Content-Type`, `Allow-Methods: POST`) and return 2xx. In test mode (`data-test="1"`) the POST
is sent too, with `"test": true` and a fake txid, so you can test your endpoint. **Check the txid on your side before shipping.**
If your page has a CSP, add your endpoint to `connect-src`.

**No server? Recommendation**

| option | pros | cons |
|---|---|---|
| **`data-shipping-email` only** (recommended start) | zero infrastructure, nothing passes through any third party except the shop's own mail provider, works today | buyer must press "send" in their mail app; needs a mail app/webmail handler; not automatic |
| **form service of the shop's choice** as `data-shipping-url` (any service that accepts JSON POST with CORS) | automatic, no own server | a third party chosen by the shop stores the data → shop needs a data processing agreement (DSGVO/GDPR AV contract) |
| **both** (URL + email) | automatic, and the mail button appears if the URL fails | as above |
| **events only** | full control | needs own JS / backend |

If `data-shipping="1"` is set without URL and email, the address is only available as a page event.

## How payment detection works

1. When the dialog opens an **invoice** is created: amount + random **1–99 sats tag** (e.g. 50,000 → 50,037 sats),
   a `since` timestamp and a 15 min deadline. The exact amount is shown and is inside the QR / wallet link.
2. The widget takes a **baseline** of all transactions already known for the address (mempool + last 20 confirmed).
3. Every ~5 s it reads the address' **unconfirmed** history (and every 4th poll the confirmed one).
   Each *new* tx (not in the baseline) is fetched and its outputs to the address's P2PKH script are summed
   (same logic as Ask Kallubi's `satsToPayAddress()`). Match = sum **≥ invoice amount**, and not older than `since`.
4. Errors / HTTP 429 → exponential backoff up to 30 s; background tabs poll every 15 s.
5. Closing the dialog does **not** stop watching until the window expires, so "paid, then closed" is still detected.
   Re-opening within the window shows the same invoice.

Three guards against matching an old payment: baseline, `since`, and the unique sats tag.

### Detection sources (v1.2.0)

1. **Kallubi's own BSV node first.** The widget asks the Kallubi node API for the address history (needs the
   Kallubi address index), then fetches every new candidate tx **as raw hex** and its confirmations from the own node.
2. **Public fallback only where the own node cannot answer:** no address index yet (the node answers
   `404 not available` once, the widget remembers it), node unreachable, or tx not known to the node yet.
   `data-fallback="0"` turns the fallback off.
3. **No source is trusted for the amount.** The raw tx is hashed in the browser (double SHA-256 must equal the txid),
   parsed with bounds checks, and only outputs whose locking script is *exactly* the merchant's P2PKH script are summed
   (integer satoshis). A forged or wrong answer from either source is ignored.
4. **Confirmations:** `confirmations >= 1` on the node's best chain. Orphaned blocks / `-1` count as 0.
5. **Dropped payments:** if a seen tx is unknown to every reachable source for 4 checks in a row and at least 2 minutes
   (double spend, replaced, evicted), the widget shows "Payment not confirmed" and fires `kallubi:dropped`
   (never `kallubi:paid`). Unreachable sources never count as "dropped".
6. **No double counting:** a txid that paid one invoice is never accepted for another invoice on the same page.

Known limits: outputs with extra data after the P2PKH script are not counted (conservative); 0-conf invoices
can still be double-spent after `kallubi:paid` (even after the 5 s quick-check window) — that is the merchant's remaining 0-conf risk.

The check worker (`worker/`, `data-api=…`) stays in the repo as an option; it is not deployed.

### Worker API (not deployed)

`GET /api/pay/check?to=<address>&amount=<sats>&since=<unix>` →
`{ "ok": true, "matches": [{ "txid": "…", "sats": 50037, "confirmations": 0 }] }`
Errors: `400 bad_address|bad_amount|bad_since`, `429 rate_limited`, `503 upstream_busy` (+`Retry-After`), `502 upstream`.

## Security & privacy

- Non-custodial, receive-only: only the public address is ever used.
- All merchant input is rendered with `textContent` / `setAttribute` (no `innerHTML`); labels are length-capped
  and URL-encoded in the `bitcoin:` URI; the explorer link is built only from a validated 64-hex txid.
- Shadow DOM + `:host{all:initial}` isolates the widget from the shop's CSS (tested with hostile CSS).
- `data-order-id` is validated against a strict character set; random order references come from `crypto.getRandomValues`.
- Browser events are UX only; payment decisions belong on the shop server (`verify/`).
- No cookies, no localStorage, no analytics, no external fonts or CDNs. QR code is generated locally
  (vendored `qrcode-generator` 1.4.4, MIT). `fetch` uses `credentials:'omit'`, `referrerPolicy:'no-referrer'`.
- With `data-shipping-url`, the only extra host the widget contacts is that merchant URL (validated: https only, no credentials in the URL).
- Shops with a strict CSP must allow `script-src https://pay.kallubi-bsv-explorer.de` and
  `connect-src https://node.kallubi-bsv-explorer.de` plus the fallback API host from `src/button.js` (or the worker URL), plus `https://api.coingecko.com` and `https://data-api.ecb.europa.eu` when using `data-amount-fiat` or the default EUR confirmation line, and `https://arcade-eu-1.bsvblockchain.tech https://arcade-us-1.bsvblockchain.tech https://arcade.gorillapool.io` for the quick check. No `style-src 'unsafe-inline'` is needed in modern
  browsers: the styles are applied as a constructable stylesheet inside the shadow root (tested with `style-src 'none'`).

## Files

```
dist/button.js        readable bundle (src + vendored QR lib)
dist/button.min.js    minified (~125 KB, ~41 KB gzip)  <- this is what shops embed (hosted as /button.js)
src/button.js         source
vendor/               qrcode-generator 1.4.4 (MIT, Kazuhiko Arase)
worker/               optional check proxy (Cloudflare Worker, wrangler.toml, NOT deployed)
verify/               server-side payment verification for shops (Node 18+, no dependencies)
demo/index.html       two fake shops (light + dark), test mode
tests/                headless Chromium (Playwright) + Node worker tests, incl. a live read-only mainnet check
shots/                screenshots written by the tests (not in the repo)
build.mjs             build: npm install && node build.mjs
```

## Develop / running tests

Build needs `npm install` (terser). Browser tests need Python Playwright and Chrome.

```bash
npm install && node build.mjs
python3 -m http.server 8765 --bind 127.0.0.1 &      # then open http://127.0.0.1:8765/demo/
python tests/test_widget.py                           # browser checks (needs playwright + chrome)
python tests/test_confirm.py                          # 0-conf vs. 1-confirmation, chain mocked, strict CSP
python tests/test_i18n.py                             # language choice, all 6 dictionaries, no English left in German
python tests/test_logo.py                             # real Kallubi logo in every mark, QR still scans
python tests/test_shipping.py                         # shipping off (baseline), form, validation, 6 languages, POST to a mock merchant, mailto, privacy
python tests/test_realmode_smoke.py                   # real mode: own node first (mocked down), fallback, no referrer/cookies
python tests/test_node.py                             # source selection, forged hex/JSON, under/overpay, split outputs, orphaned, no double count, dropped vs. unreachable, parser fuzz
python tests/e2e_regtest.py                           # optional: a REAL local regtest chain (setup not included; skipped unless KALLUBI_E2E_* are set)
python tests/test_v120.py                             # fiat, order id, expiry/late, confirmation policy, v1.0.0 compatibility, strict CSP (all sources mocked)
node tests/worker.test.mjs                            # worker checks (mocked chain API + live read-only)
node tests/verify.test.mjs                            # server-side verification (raw tx parser, amounts, replay, expiry, RPC, rates, confirmation policy)
```

## Changelog

### 1.2.0 — fiat prices, own-node detection, confirmation policy, server-side verification

- `data-amount-fiat` + `data-currency="EUR|USD"`: CoinGecko first; backup USD = WhatsOnChain, EUR = WhatsOnChain USD ÷
  ECB EUR/USD reference rate; the rate source is shown; no QR without a fresh rate.
- Confirmation policy: EUR line (default 200.00) with a quick check (own node + BSV Broadcaster, 5 s window, final tx,
  sufficient fee); 20.00 EUR fallback when the check is unavailable; USD converted from EUR with the ECB rate; BSV
  converted with the EUR/BSV rate; `data-confirm-above-fiat="0"` = always wait.
- `data-order-id` (strict) with a random `kp-…` reference when absent, `data-expires-min`, `kallubi:expired` and
  `kallubi:late` (a late payment is flagged, never reported as paid).
- Detection via Kallubi's own node first, public fallback only where needed (`data-node`, `data-fallback`); amounts
  only from verified raw transactions (txid check, integer sats, exact script); a tx counts once per page; new
  `kallubi:dropped` event + view when a seen payment disappears.
- `verify/kallubi-verify.mjs` for shops: raw-tx check, exact amount, replay protection, expiry, the same confirmation
  policy, rates with the same backup (ECB daily XML).
- Without the new attributes the button behaves like 1.0.0; events only gained fields.

### 1.0.0 — first public release

Payment QR/button, confirmations (`data-confirm-above`), six languages (en, de, es, fr, it, pt), the Kallubi logo, optional shipping address (`data-shipping`, `data-shipping-email`, `data-shipping-url`), and strict address/amount validation (mainnet P2PKH only; 1 satoshi to 21,000,000 BSV, with specific error texts).

## Known limits

- Mainnet P2PKH `1…` addresses only (no paymail, no P2SH, no testnet).
- Fiat: EUR and USD only. Rate sources: CoinGecko, backup WhatsOnChain (+ ECB reference rate for EUR).
- Six UI languages; left-to-right scripts only.
- Detection needs the own node or the public fallback to be reachable (with `data-fallback="0"`: the own node only).
- A payment that arrives after the 15 min window is not shown in the dialog (the money still arrives
  at the merchant's address, the dialog tells the buyer not to pay twice).

- Shipping: the browser POST is best effort (buyer may close the tab before the payment is seen → use the
  email fallback or events). Free-text fields only (no address verification); amounts are the same for every country (no shipping fee logic).

License: Apache-2.0 (see `LICENSE` and `NOTICE`). Bundled QR library: MIT © 2009 Kazuhiko Arase.
