# Changelog

## 0.1.0 (2026-11-24)

First release.

- Reads x402 402 Payment Required quotes in every format the spec defines: the v2 `PAYMENT-REQUIRED` header (base64 JSON), the v1 JSON body, and the MCP transport's tool result (`structuredContent` or `content[0].text`). Spec: x402 v2 (v2.0, 2025-12-9) and v1, at x402-foundation/x402 commit 0e6e8c5.
- Prices each `exact` or `upto` option in USD only when its asset is in x402's own USD-pegged default asset table (42 assets on 32 networks, copied with attribution in NOTICE). Anything else, including fiat codes and unknown tokens, is left unpriced and says why.
- Compares the cheapest priceable option with justweight's list cost for the same model and token counts (cheapest listing by default, or the median), and rejects anything over `--max-premium` (25% by default). Models justweight doesn't list are rejected unless `--allow-unlisted`.
- Budget through agent-spendcap: an approved quote must also pass the policy, and places a hold you settle or release.
- `guardedFetch()`: fetch that stops at a 402, checks the quote, and only then calls your own `pay()`. Settles `upto` holds at the amount in `PAYMENT-RESPONSE`, releases on a failed settlement.
- CLI: `demo`, `check`, `probe`, `status`, `settle`, `release`. MCP server: `x402_price_check`, `x402_settle`, `x402_release`, `x402_budget`.
- A mock x402 endpoint (`x402-price-check/mock`) for tests and the demo. It accepts mock payments only.
- No signing, no wallet, no keys, no chain access: this package never pays anything.
