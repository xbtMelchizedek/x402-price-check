// Is this x402 quote a fair price for this inference call? Browser-safe: justweight's pure core only.
import { canonicalModel, costOf, medianFixed, fromFixed } from 'justweight/core';
import { usdOf, SPEC } from './x402.mjs';

const FIXED_PER_NANO = 10n ** 15n; // justweight fixed point 1e-24 → nano-USD 1e-9
const DEC = /^\d+(\.\d{1,9})?$/;
export const SCHEMES = ['exact', 'upto']; // x402 schemes whose amount is a price (exact) or a ceiling (upto)

/** justweight's model key, plus Anthropic API ids ("claude-sonnet-5-5-20261001" → "claude-sonnet-5.5"). */
export function modelKey(id) {
  let k = canonicalModel(id).key;
  if (k.startsWith('claude-')) k = k.replace(/-\d{8}$/, '').replace(/(\d)-(\d)/g, '$1.$2');
  return k;
}

const usable = (o) => o.unit === 'USD' && DEC.test(String(o.inPer1M)) && DEC.test(String(o.outPer1M)) && !canonicalModel(o.model).variant.some((v) => /(^|-)batch$/.test(v));
const toNano = (fixed) => (fixed + FIXED_PER_NANO - 1n) / FIXED_PER_NANO;

/** List prices in justweight for this model at these token counts: cheapest and median, batch tiers skipped. */
export function referencePrice(snapshot, model, inputTokens, outputTokens) {
  const k = modelKey(model);
  const rows = [];
  for (const o of snapshot?.offers ?? []) {
    if (!usable(o) || modelKey(o.model) !== k) continue;
    const c = costOf(o, { inputTokens, outputTokens });
    if (c !== null) rows.push({ o, c });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : a.o.provider.localeCompare(b.o.provider)));
  const med = medianFixed(rows.map((r) => fromFixed(r.c, 24)));
  const c0 = rows[0];
  return {
    modelKey: k, listings: rows.length, snapshotAt: snapshot.generatedAt ?? null,
    cheapest: { nano: toNano(c0.c), provider: c0.o.provider, model: c0.o.model, inPer1M: c0.o.inPer1M, outPer1M: c0.o.outPer1M, source: c0.o.source },
    median: { nano: toNano(med) },
  };
}

const utf8 = (s) => new TextEncoder().encode(s).length;

/** Token counts for the comparison. Without inputTokens, request bytes stand in (1 token >= 1 byte: an upper bound). */
export function requestSize(req) {
  if (!req || typeof req.model !== 'string' || !req.model) throw new Error('request.model is required');
  const out = req.maxOutputTokens;
  if (!Number.isSafeInteger(out) || out < 0) throw new Error('request.maxOutputTokens is required (the max_tokens you will send)');
  if (Number.isSafeInteger(req.inputTokens) && req.inputTokens >= 0) return { model: req.model, input: req.inputTokens, inputBasis: 'given', output: out };
  if (typeof req.input === 'string') return { model: req.model, input: utf8(req.input), inputBasis: 'bytes (upper bound on tokens)', output: out };
  throw new Error('give request.inputTokens, or request.input (the prompt or messages JSON) to bound it');
}

/** From an OpenAI- or Anthropic-style request body. */
export function requestFromBody(body, { inputTokens } = {}) {
  const input = body.messages ?? body.input ?? body.prompt;
  return {
    model: body.model,
    inputTokens,
    input: input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify([body.system ?? null, input, body.tools ?? null]),
    maxOutputTokens: [body.max_tokens, body.max_completion_tokens, body.max_output_tokens].find((x) => Number.isSafeInteger(x) && x >= 0),
  };
}

export const usd = (nano) => {
  const n = BigInt(nano);
  const neg = n < 0n; const a = neg ? -n : n;
  const f = (a % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / 1_000_000_000n}${f ? `.${f}` : ''}`;
};

function pctToBps(p) {
  const s = String(p);
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) throw new Error('maxPremiumPct must be a percentage like 25 or 12.5');
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
}

/**
 * Price check only: it never pays. Returns a verdict with every number it used and where it came from.
 * @param pr       normalized PaymentRequired (from parsePaymentRequired / normalizePaymentRequired)
 * @param req      { model, maxOutputTokens, inputTokens? | input? }
 * @param o        { snapshot, assets, maxPremiumPct='25', reference='cheapest'|'median', allowUnlisted=false }
 */
export function evaluate(pr, req, { snapshot, assets, maxPremiumPct = '25', reference = 'cheapest', allowUnlisted = false } = {}) {
  const size = requestSize(req);
  const maxBps = pctToBps(maxPremiumPct);
  if (!['cheapest', 'median'].includes(reference)) throw new Error('reference must be cheapest or median');
  const options = pr.accepts.map((a) => {
    if (!SCHEMES.includes(a.scheme)) return { index: a.index, scheme: a.scheme, network: a.networkRaw, usd: null, reason: `scheme ${a.scheme} is not priced by this check (exact and upto are)` };
    const u = usdOf(a, assets);
    return { index: a.index, scheme: a.scheme, network: a.network ?? a.networkRaw, asset: a.asset, amount: a.amount, usd: u.nano === null ? null : usd(u.nano), nano: u.nano, symbol: u.symbol ?? null, reason: u.reason ?? null };
  });
  const priced = options.filter((x) => x.nano !== null && x.nano !== undefined).sort((a, b) => (a.nano < b.nano ? -1 : a.nano > b.nano ? 1 : a.index - b.index));
  const ref = referencePrice(snapshot, size.model, size.input, size.output);
  const reasons = [];
  const pick = priced[0] ?? null;
  let premiumBps = null;
  let refNano = null;
  if (!pick) reasons.push(`no option is priced in a known USD stablecoin: ${options.map((x) => x.reason).join('; ')}`);
  if (!ref) {
    if (!allowUnlisted) reasons.push(`justweight lists no USD price for ${size.model} (key ${modelKey(size.model)}), so there is nothing to compare against`);
  } else if (pick) {
    refNano = reference === 'median' ? ref.median.nano : ref.cheapest.nano;
    if (refNano === 0n) premiumBps = pick.nano === 0n ? 0n : null;
    else {
      const d = (pick.nano - refNano) * 10_000n;
      premiumBps = d >= 0n ? (d + refNano - 1n) / refNano : d / refNano; // round toward a higher premium
    }
    if (premiumBps === null || premiumBps > maxBps) reasons.push(`quote $${usd(pick.nano)} is ${premiumBps === null ? 'above a free list price' : `${bpsPct(premiumBps)}% over`} the ${reference} list price $${usd(refNano)} (max ${bpsPct(maxBps)}%)`);
  }
  return {
    verdict: reasons.length ? 'reject' : 'approve',
    reasons,
    quote: pick ? { index: pick.index, scheme: pick.scheme, network: pick.network, asset: pick.asset, amount: pick.amount, symbol: pick.symbol, usd: pick.usd, ceiling: pick.scheme === 'upto' } : null,
    reference: ref ? { basis: reference, usd: usd(refNano ?? (reference === 'median' ? ref.median.nano : ref.cheapest.nano)), cheapest: { ...ref.cheapest, usd: usd(ref.cheapest.nano), nano: undefined }, medianUsd: usd(ref.median.nano), listings: ref.listings, modelKey: ref.modelKey, snapshotAt: ref.snapshotAt } : null,
    premiumPct: premiumBps === null ? null : bpsPct(premiumBps),
    maxPremiumPct: bpsPct(maxBps),
    tokens: { input: size.input, inputBasis: size.inputBasis, output: size.output },
    resource: pr.resource,
    x402Version: pr.version,
    options: options.map(({ nano, ...x }) => x),
    spec: `x402 v${pr.version} (${SPEC.repo} @ ${SPEC.commit.slice(0, 7)})`,
  };
}

function bpsPct(b) {
  const neg = b < 0n; const a = neg ? -b : b;
  const f = (a % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / 100n}${f ? `.${f}` : ''}`;
}
