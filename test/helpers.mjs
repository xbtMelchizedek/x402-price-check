import { readFileSync } from 'node:fs';
import { normalizePaymentRequired } from '../src/x402.mjs';
import { loadAssets } from '../src/data.mjs';

export const SNAP = JSON.parse(readFileSync(new URL('./fixtures/snapshot.json', import.meta.url), 'utf8'));
export const SNAP_FILE = new URL('./fixtures/snapshot.json', import.meta.url).pathname;
export const spec = (f) => readFileSync(new URL(`./fixtures/spec/${f}`, import.meta.url), 'utf8');
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const V1N = loadAssets().v1Networks;

/** A v2 PaymentRequired with one option per [amount, scheme?, asset?, network?]. */
export function quoteOf(...opts) {
  return normalizePaymentRequired({
    x402Version: 2, resource: { url: 'http://mock.test/v1/chat/completions' },
    accepts: opts.map(([amount, scheme = 'exact', asset = USDC, network = 'eip155:84532']) => ({ scheme, network, amount, asset, payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 60 })),
  });
}
// deepseek-v4.1-flash in the fixture: cheapest openrouter 0.0507 in / 0.2028 out per 1M, so 2000 in + 1000 out = $0.0003042
export const DS = { model: 'deepseek/deepseek-v4.1-flash', inputTokens: 2000, maxOutputTokens: 1000 };
