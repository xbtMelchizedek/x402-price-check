# Contributing to x402-price-check

Small, finished pull requests with tests are the easiest to merge.

```sh
git clone https://github.com/xbtMelchizedek/x402-price-check && cd x402-price-check
npm install && npm test
```

## Ground rules

- **This package never pays.** No signing, wallets, keys, RPC calls or payment payloads beyond the clearly labelled mock in `src/mock.mjs`. Payment stays in the caller's `pay()`.
- **Follow the spec text.** New fields or transports cite the section of the x402 spec they come from, at a pinned commit. Spec examples go in `test/fixtures/spec/` and are credited in NOTICE.
- **Never invent a price.** A quote is priced only from x402's own USD-pegged asset table, and the reference only from justweight's snapshot. When either is missing, the result says so and rejects.
- **Exact amounts.** Atomic units and nano-USD are BigInt; USD is a decimal string. No floats.
- **When in doubt, round against the seller.** Quotes round up, premiums round up.
- **New price sources belong in justweight**, new budget rules in agent-spendcap.

To refresh the asset table from a newer x402 commit: `node scripts/sync-assets.mjs /path/to/x402-checkout`, then update the commit in NOTICE and `SPEC` in `src/x402.mjs`.

## Pull requests

One change per PR, with tests. CI runs `npm test` and a secret scan. Security findings go through [SECURITY.md](SECURITY.md), never into a public issue.
