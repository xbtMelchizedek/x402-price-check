# x402-price-check

An inference endpoint answers **402 Payment Required** with an [x402](https://github.com/x402-foundation/x402) quote. Before your agent pays it, is it a fair price? `x402-price-check` reads the quote, works out what it costs in USD, compares that with what [justweight](https://github.com/xbtMelchizedek/justweight) lists for the same model and token counts, and approves only if it's within your max premium and your [agent-spendcap](https://github.com/xbtMelchizedek/agent-spendcap) budget. It ships as a library, a CLI and an MCP tool.

It never pays. It holds no keys, signs nothing and never touches a chain. When a quote passes, your own wallet code makes the payment.

**Page and in-browser checker:** https://xbtmelchizedek.github.io/x402-price-check/

## Quickstart

```sh
npx -y github:xbtMelchizedek/x402-price-check demo
```

The demo starts a local **mock** x402 endpoint, has it quote list price +10% and then 3x list, and runs both quotes through the check against today's justweight prices. The fair quote is paid with a mock payment; the other is refused before anything is sent. With the justweight snapshot of 2026-11-24 21:38 UTC:

```
APPROVE  $0.000335 USDC on eip155:84532 (exact) vs cheapest list $0.0003042 (openrouter deepseek/deepseek-v4.1-flash; median $0.0003521 of 2), premium 10.13% (max 25%)
REJECT  $0.000913 USDC on eip155:84532 (exact) vs cheapest list $0.0003042 (openrouter deepseek/deepseek-v4.1-flash; median $0.0003521 of 2), premium 200.14% (max 25%)
```

Check a real endpoint's quote without paying it:

```sh
npx -y github:xbtMelchizedek/x402-price-check probe https://api.example.com/v1/chat/completions --body request.json
```

Node 22 or later. Exit code 0 means approve, 1 reject, 2 bad input.

## Which x402

Written from the spec text at [x402-foundation/x402 @ 0e6e8c5](https://github.com/x402-foundation/x402/tree/0e6e8c55d86b4f14234fb6e49a4052074fb93e57/specs) (2026-10-15):

| Where the quote comes from | Spec | Field read |
|---|---|---|
| HTTP `PAYMENT-REQUIRED` header, base64 JSON | x402 **v2** (Protocol Version 2, v2.0 of 2025-12-9), `transports-v2/http.md` | `accepts[].amount`, CAIP-2 `network` |
| HTTP 402 JSON body | x402 **v1**, `transports-v1/http.md` | `accepts[].maxAmountRequired`, network names like `base-sepolia` |
| MCP tool result, `isError: true` | `transports-v2/mcp.md` | `structuredContent`, else `content[0].text` |

The spec's own examples for all three are in the tests. Settlement is read from `PAYMENT-RESPONSE` (v2) or `X-PAYMENT-RESPONSE` (v1).

## How the check works

1. **Quote in USD.** Each `exact` or `upto` option is priced only if its asset is in x402's own table of USD-pegged default assets (USDC, USDT, PYUSD and others on 32 networks; the same reverse lookup the x402 SDK suggests for client-side USD caps). `amount / 10^decimals`, rounded up. Anything else is left unpriced with the reason: fiat codes such as `USD`, unknown tokens, and the `batch-settlement` and `auth-capture` schemes. The cheapest priced option is the one checked.
2. **List price.** The cost in justweight's snapshot for the same model at your input tokens and your `max_tokens`, at the cheapest listing (default) or the median. Batch-only tiers are skipped. Without an input token count, the request's byte length stands in. A token is at least one byte, so this is an upper bound, and the premium shown is then a lower bound. Pass `--input-tokens` when you know it.
3. **Premium.** `(quote − list) / list`, rounded up. Over `--max-premium` (default 25%) is a reject. A model justweight doesn't list is a reject unless you pass `--allow-unlisted`.
4. **Budget.** With `--max-call`/`--max-day` or an agent-spendcap `--policy`, an approved quote must also pass the policy. It then places a hold on a local ledger (mode 600) that you settle or release.

Output is always compared at your maximum output, which is the price the seller is entitled to ask. For `upto`, the amount is a ceiling. `guardedFetch` settles the hold at the amount the server reports.

## Library

```js
import { guardedFetch, PaymentRefused } from 'x402-price-check';

const res = await guardedFetch(url, { method: 'POST', body }, {
  request: { model: 'deepseek/deepseek-v4.1-flash', inputTokens: 2000, maxOutputTokens: 1000 },
  snapshot,                // a justweight snapshot: await loadSnapshot(SNAPSHOT_URL)
  cap,                     // optional agent-spendcap SpendCap
  maxPremiumPct: '25',
  pay: async ({ option, paymentRequired }) => yourWallet.paymentHeader(option), // your code; this package never signs
});
// throws PaymentRefused (with .result) before pay() is called if the quote is unfair or over budget
```

Also exported:
- `readPaymentRequired`, `parsePaymentRequired`, `parseMcpPaymentRequired` and `parseSettlement` for parsing.
- `check(pr, request, opts)` for the verdict with a budget hold.
- `evaluate` for the pure price check, which is browser-safe.
- `referencePrice`, `usdOf`, `loadSnapshot` and `SPEC`.

`x402-price-check/mock` is the mock endpoint used by the tests and the demo. It accepts mock payments only.

## MCP

```json
{ "mcpServers": { "x402-price-check": { "command": "npx", "args": ["-y", "github:xbtMelchizedek/x402-price-check", "mcp", "--max-day", "1"] } } }
```

The server exposes four tools:
- `x402_price_check({ quote, request | body, maxPremiumPct?, reference? })`. `quote` can be the header value, the v1 body, the PaymentRequired object or the whole MCP tool result.
- `x402_settle` and `x402_release` for holds.
- `x402_budget`.

## CLI

```
x402-price-check demo
x402-price-check check --quote <file|base64|-> (--body req.json | --model <id> --max-tokens <n> [--input-tokens <n> | --prompt-file <f>])
x402-price-check probe <url> --body req.json
x402-price-check status | settle --id <hold> --usd <paid> | release --id <hold>
x402-price-check mcp
```

Options: `--max-premium <pct>`, `--reference cheapest|median`, `--allow-unlisted`, `--max-call <usd>`, `--max-day <usd>`, `--policy <file>`, `--ledger <file>` (default `~/.x402-price-check/ledger.jsonl`), `--snapshot <url|file>`, `--json`.

## Limits

- **USD-pegged assets only.** The table is x402's own list of defaults. A quote in another token is not converted at a market rate; it is refused with the reason.
- **List price is not a guarantee.** justweight lists what venues publish. A seller may add real value, such as privacy, latency or no account, which is what `--max-premium` is for.
- **Token counts are yours to give.** The quote doesn't say how many tokens it covers, so the comparison assumes your `max_tokens`.
- **Not a payment client.** No `PAYMENT-SIGNATURE` or `X-PAYMENT` is made here except the mock one in tests and the demo. Pair it with an x402 client that signs.

## Part of the agent inference kit

x402-price-check is one of a set of small tools for agents that pay for inference. Each does one job, and they work together. The full list is sorted by job, with a one-line command and a live number for each: **https://xbtmelchizedek.github.io/agent-inference-kit/**. Its source is [kit.json](https://github.com/xbtMelchizedek/agent-inference-kit/blob/main/kit.json), so adding a tool takes one change there.

## Develop

```sh
git clone https://github.com/xbtMelchizedek/x402-price-check && cd x402-price-check
npm install && npm test
node scripts/sync-assets.mjs /path/to/x402   # refresh src/assets.json from an x402 checkout
```

35 tests, using the mock endpoint and mock payments only: no network, no keys, no chain. Dependencies: agent-spendcap and justweight. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

MIT, with x402 data under Apache-2.0 (see [NOTICE](NOTICE)). The page uses Arc UI foundation tokens (MIT, see `web/arc/LICENSE`).
