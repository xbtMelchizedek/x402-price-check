// The gate in front of a payment: price check, then an agent-spendcap hold, then (only if both pass) the caller's
// own pay() makes the payment header. This package never signs, holds keys or moves money; pay() is yours.
import { parsePaymentRequired, parseSettlement, usdOf } from './x402.mjs';
import { evaluate, usd } from './compare.mjs';
import { loadAssets } from './data.mjs';

export class PaymentRefused extends Error {
  constructor(result) { super(`x402 payment refused: ${result.reasons.join('; ')}`); this.name = 'PaymentRefused'; this.result = result; }
}

const venueOf = (url) => { try { return `x402:${new URL(url).host}`.slice(0, 120); } catch { return 'x402:unknown'; } };

/**
 * Price check plus budget. With a SpendCap, an approved quote also needs cap.authorize() to pass; the hold it
 * places is returned so you settle() or release() it after paying. Quotes of $0 need no hold.
 */
export function check(pr, req, { cap = null, venue, ...opts } = {}) {
  const assets = opts.assets ?? loadAssets();
  const r = evaluate(pr, req, { ...opts, assets: assets.networks });
  r.budget = null;
  if (r.verdict !== 'approve' || !cap) return r;
  if (r.quote.usd === '0') { r.budget = { ok: true, hold: null, note: 'free quote: no hold' }; return r; }
  const a = cap.authorize({ venue: venue ?? venueOf(pr.resource.url), model: String(req.model).slice(0, 120), usd: r.quote.usd, purpose: 'x402' });
  r.budget = a.ok ? { ok: true, hold: a.id, reservedUsd: a.reservedUsd, remaining: a.remaining } : { ok: false, reasons: a.reasons };
  if (!a.ok) { r.verdict = 'reject'; r.reasons.push(...a.reasons.map((x) => `spendcap: ${x}`)); }
  return r;
}

/**
 * fetch() that stops at a 402: checks the quote, and pays only if it is approved and within budget.
 * pay({ option, paymentRequired, result }) must return the payment header value (base64 PaymentPayload); for
 * x402 v2 it goes in PAYMENT-SIGNATURE, for v1 in X-PAYMENT. Throws PaymentRefused on a reject.
 */
export async function guardedFetch(url, init = {}, { request, pay, cap = null, fetch: f = globalThis.fetch, ...opts }) {
  const first = await f(url, init);
  if (first.status !== 402) return Object.assign(first, { x402: null });
  const assets = opts.assets ?? loadAssets();
  const pr = parsePaymentRequired({ status: 402, headers: first.headers, bodyText: await first.text() }, { v1Networks: assets.v1Networks });
  const result = check(pr, request, { ...opts, assets, cap, venue: opts.venue ?? venueOf(url) });
  if (result.verdict !== 'approve') throw new PaymentRefused(result);
  const option = pr.accepts[result.quote.index];
  const hold = result.budget?.hold ?? null;
  let res;
  try {
    const header = await pay({ option: option.raw, paymentRequired: pr, result });
    if (typeof header !== 'string' || !header) throw new Error('pay() must return the payment header value');
    const headers = new Headers(init.headers ?? {});
    headers.set(pr.version === 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT', header);
    res = await f(url, { ...init, headers, redirect: 'error' }); // never carry a payment to another URL
  } catch (e) {
    if (hold) cap.release(hold); // nothing was sent, or the request never reached the server
    throw e;
  }
  const settlement = parseSettlement(res.headers);
  let paidUsd = null;
  if (hold) {
    if (settlement && !settlement.success) cap.release(hold);
    else if (settlement?.amount) {
      const n = usdOf({ ...option, amount: settlement.amount }, assets.networks).nano;
      paidUsd = usd(n ?? BigInt(0));
      cap.settle(hold, paidUsd, { receipt: settlement.transaction || null });
    } else if (res.ok) {
      paidUsd = result.quote.usd; // exact: the quoted amount; upto without an amount: assume the ceiling
      cap.settle(hold, paidUsd, { receipt: settlement?.transaction || null });
    } // else: outcome unknown, the hold stays open and counts as spent (agent-spendcap's safe default)
  }
  return Object.assign(res, { x402: { result, settlement, paidUsd, hold } });
}
