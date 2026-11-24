# Security

Report vulnerabilities privately through GitHub's **Report a vulnerability** button on this repository (Security tab, then Advisories). Please don't open a public issue.

In scope:
- A quote this tool approves that it should have rejected: a wrong USD conversion, a premium that rounds in the seller's favour, an option chosen that isn't the one priced, a v1/v2 field mix-up.
- `guardedFetch()` calling `pay()` after a reject or a budget denial, or sending the payment header to a different URL than the one that quoted.
- A hold left unreleased, or settled at the wrong amount, in a way that lets spending pass a budget.
- Parser crashes or excessive memory on hostile 402 headers or bodies.

This package holds no keys and signs nothing. `pay()` is supplied by the caller.
