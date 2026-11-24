import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, referencePrice, requestFromBody, modelKey, requestSize } from '../src/compare.mjs';
import { loadAssets } from '../src/data.mjs';
import { SNAP, quoteOf, DS } from './helpers.mjs';

const assets = loadAssets().networks;
const ev = (pr, req = DS, o = {}) => evaluate(pr, req, { snapshot: SNAP, assets, ...o });

test('reference price: cheapest and median list cost for the exact token counts, batch tiers skipped', () => {
  const r = referencePrice(SNAP, DS.model, 2000, 1000);
  assert.equal(r.cheapest.nano, 304_200n);
  assert.equal(r.cheapest.provider, 'openrouter');
  assert.equal(r.listings, 2); // :batch row excluded
  assert.equal(referencePrice(SNAP, 'no-such-model', 1, 1), null);
});

test('approves within the max premium, rejects above it, with the numbers', () => {
  const ok = ev(quoteOf(['350'])); // $0.00035 vs $0.0003042 → 15.06%
  assert.equal(ok.verdict, 'approve');
  assert.equal(ok.premiumPct, '15.06');
  assert.equal(ok.reference.usd, '0.0003042');
  const no = ev(quoteOf(['350']), DS, { maxPremiumPct: '15' });
  assert.equal(no.verdict, 'reject');
  assert.match(no.reasons[0], /15\.06% over the cheapest list price \$0\.0003042 \(max 15%\)/);
  assert.equal(ev(quoteOf(['200'])).premiumPct, '-34.25'); // below list: a discount
});

test('median reference is more lenient than cheapest', () => {
  const r = ev(quoteOf(['400']), DS, { reference: 'median' });
  assert.equal(r.reference.usd, r.reference.medianUsd);
  assert.equal(r.verdict, 'approve');
  assert.equal(ev(quoteOf(['400'])).verdict, 'reject');
});

test('picks the cheapest priceable option and explains the others', () => {
  const r = ev(quoteOf(['999', 'exact'], ['100', 'exact', 'USD'], ['300', 'batch-settlement'], ['330', 'exact']));
  assert.equal(r.quote.index, 3);
  assert.equal(r.quote.usd, '0.00033');
  assert.match(r.options[1].reason, /not a USD-pegged/);
  assert.match(r.options[2].reason, /scheme batch-settlement is not priced/);
});

test('upto: the amount is a ceiling, compared with list cost at max output', () => {
  const r = ev(quoteOf(['350', 'upto']));
  assert.equal(r.quote.ceiling, true);
  assert.equal(r.verdict, 'approve');
});

test('no USD option, or an unlisted model, is a reject unless allowUnlisted', () => {
  assert.match(ev(quoteOf(['1', 'exact', 'USD'])).reasons[0], /no option is priced/);
  const un = ev(quoteOf(['350']), { ...DS, model: 'mystery-model-9' });
  assert.equal(un.verdict, 'reject');
  assert.match(un.reasons[0], /justweight lists no USD price/);
  assert.equal(ev(quoteOf(['350']), { ...DS, model: 'mystery-model-9' }, { allowUnlisted: true }).verdict, 'approve');
});

test('free quotes pass; zero-token requests compare against $0', () => {
  assert.equal(ev(quoteOf(['0'])).verdict, 'approve');
  const z = ev(quoteOf(['1']), { ...DS, inputTokens: 0, maxOutputTokens: 0 });
  assert.equal(z.verdict, 'reject');
});

test('request size: bytes bound unknown input tokens; bodies read max_tokens', () => {
  const s = requestSize({ model: 'm', input: 'héllo', maxOutputTokens: 5 });
  assert.deepEqual([s.input, s.inputBasis], [6, 'bytes (upper bound on tokens)']);
  assert.throws(() => requestSize({ model: 'm', maxOutputTokens: 5 }), /inputTokens/);
  assert.throws(() => requestSize({ model: 'm', inputTokens: 1 }), /maxOutputTokens/);
  const r = requestFromBody({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 64 });
  assert.equal(r.maxOutputTokens, 64);
  assert.ok(r.input.includes('"hi"'));
  assert.equal(requestFromBody({ model: 'x', prompt: 'abc', max_tokens: 1 }).input, 'abc');
});

test('model keys: provider prefixes and Anthropic dated ids', () => {
  assert.equal(modelKey('deepseek/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(modelKey('claude-sonnet-5-5-20261001'), 'claude-sonnet-5.5');
});

test('maxPremiumPct is validated', () => {
  assert.throws(() => ev(quoteOf(['1']), DS, { maxPremiumPct: '-5' }), /percentage/);
  assert.throws(() => ev(quoteOf(['1']), DS, { maxPremiumPct: 'lots' }), /percentage/);
  assert.equal(ev(quoteOf(['350']), DS, { maxPremiumPct: '15.07' }).verdict, 'approve');
});
