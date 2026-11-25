# Security policy

## What this project is

Kallubi Pay Button is a **receive-only, non-custodial** payment widget. It only ever uses the merchant's **public**
address. It holds no keys, seeds or secrets, has no accounts, and Kallubi never has access to anyone's funds.
The browser events (`kallubi:paid` …) are **UX signals only**; a shop must decide "paid" on its own server
(`verify/kallubi-verify.mjs`). This project has not been formally audited.

## Reporting a vulnerability

Please report security problems **privately** and give us a reasonable time to fix them before you publish details.

- Preferred: GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability").
- Alternative: email **Kallubi@proton.me** with the subject "Kallubi Pay Button security".

Please include what you found, how to reproduce it, and which version or commit you tested.
**Never send real private keys or seeds**, and never send real money as a proof; use test mode (`data-test="1"`) or a
local regtest chain.

There is no bug bounty at this stage. Credit is given if you want it.

## In scope

- Anything that makes the widget report a payment that was not made, was made to another address, or was too small
- Ways to make a forged or replaced (double-spent / non-final) transaction count as paid at 0-conf
- Ways to make `verifyPayment()` return `ok: true` for a payment that does not meet the order
- Script injection through `data-*` attributes, labels, order ids, or data returned by any chain or rate source
- Leaks of buyer data (shipping address) to anyone other than the merchant

## Out of scope

- The documented residual risk of 0-conf payments (a double-spend that appears after the quick-check window)
- Findings that need a compromised browser, operating system or merchant server
- Issues in third-party services (report those to the service)

## Known limits (by design)

- 0-conf is never 100 % safe. Shops choose their own confirmation line (`data-confirm-above-fiat`, `0` = always wait).
- Detection depends on the Kallubi node and/or a public blockchain API being reachable.
- Payments are matched by address and amount (with a small random tag). Always verify the transaction against the order
  on your server.
