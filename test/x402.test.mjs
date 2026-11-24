import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaymentRequired, normalizePaymentRequired, parseMcpPaymentRequired, readPaymentRequired, parseSettlement, usdOf, toB64json, X402FormatError, SPEC } from '../src/x402.mjs';
import { loadAssets } from '../src/data.mjs';
import { spec, USDC, V1N } from './helpers.mjs';

const A = loadAssets().networks;

test('spec examples parse: v2 object, v2 HTTP header, v1 body, MCP tool result', () => {
  const v2 = normalizePaymentRequired(JSON.parse(spec('v2-payment-required.json')));
  assert.equal(v2.version, 2);
  assert.equal(v2.resource.serviceName, 'Example Market Data');
  assert.deepEqual([v2.accepts[0].network, v2.accepts[0].amount, v2.accepts[0].asset], ['eip155:84532', '10000', USDC]);

  const hdr = parsePaymentRequired({ status: 402, headers: new Headers({ 'PAYMENT-REQUIRED': spec('v2-http-header.txt').trim() }), bodyText: '' });
  assert.equal(hdr.transport, 'http-header');
  assert.equal(hdr.accepts[0].amount, '10000');

  const v1 = parsePaymentRequired({ status: 402, headers: new Headers(), bodyText: spec('v1-payment-required.json') }, { v1Networks: V1N });
  assert.equal(v1.version, 1);
  assert.equal(v1.transport, 'http-body');
  assert.equal(v1.accepts[0].networkRaw, 'base-sepolia');
  assert.equal(v1.accepts[0].network, 'eip155:84532');
  assert.equal(v1.accepts[0].amount, '10000');
  assert.equal(v1.resource.url, 'https://api.example.com/premium-data');

  const mcp = parseMcpPaymentRequired(JSON.parse(spec('mcp-tool-result.json')));
  assert.equal(mcp.transport, 'mcp');
  assert.equal(mcp.resource.url, 'mcp://tool/financial_analysis');
  const textOnly = JSON.parse(spec('mcp-tool-result.json')); delete textOnly.structuredContent;
  assert.equal(parseMcpPaymentRequired(textOnly).accepts[0].amount, '10000');
});

test('readPaymentRequired takes a header value, JSON text, an object or an MCP result', () => {
  assert.equal(readPaymentRequired(spec('v2-http-header.txt')).transport, 'http-header');
  assert.equal(readPaymentRequired(spec('v1-payment-required.json'), { v1Networks: V1N }).accepts[0].network, 'eip155:84532');
  assert.equal(readPaymentRequired(JSON.parse(spec('mcp-tool-result.json'))).transport, 'mcp');
});

test('v1 names map to CAIP-2, including solana mainnet', () => {
  assert.equal(V1N['base-sepolia'], 'eip155:84532');
  assert.equal(V1N.base, 'eip155:8453');
  assert.match(V1N.solana, /^solana:5eykt4/);
});

test('rejects what the spec does not allow', () => {
  const ok = JSON.parse(spec('v2-payment-required.json'));
  const bad = (mut, re) => { const o = structuredClone(ok); mut(o); assert.throws(() => normalizePaymentRequired(o), (e) => e instanceof X402FormatError && re.test(e.message)); };
  bad((o) => { o.x402Version = 3; }, /unsupported x402Version/);
  bad((o) => { o.accepts = []; }, /accepts/);
  bad((o) => { o.accepts[0].amount = '10.5'; }, /atomic units/);
  bad((o) => { o.accepts[0].amount = 10000; }, /atomic units/);
  bad((o) => { delete o.accepts[0].payTo; }, /payTo/);
  bad((o) => { delete o.resource; }, /resource.url/);
  assert.throws(() => parsePaymentRequired({ status: 200, headers: {}, bodyText: '' }), /expected HTTP 402/);
  assert.throws(() => parsePaymentRequired({ status: 402, headers: { 'payment-required': 'not base64!' }, bodyText: '' }), /base64/);
  assert.throws(() => parsePaymentRequired({ status: 402, headers: {}, bodyText: 'Payment Required' }), /without a PAYMENT-REQUIRED header/);
});

test('usdOf prices only x402 default USD-pegged assets, rounding up', () => {
  const opt = (amount, asset = USDC, network = 'eip155:84532') => ({ network, networkRaw: network, amount, asset });
  assert.equal(usdOf(opt('10000'), A).nano, 10_000_000n); // 0.01 USDC
  assert.equal(usdOf(opt('10000', USDC.toLowerCase()), A).symbol, 'USDC'); // EVM addresses are case-insensitive
  assert.equal(usdOf(opt('1', '0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7', 'eip155:4326'), A).nano, 1n); // 1e-18 rounds up to 1 nano
  assert.match(usdOf(opt('100', 'USD'), A).reason, /not a USD-pegged asset/); // ISO 4217 fiat: not priced
  assert.match(usdOf(opt('100', '0x0000000000000000000000000000000000000001'), A).reason, /not a USD-pegged/);
  assert.match(usdOf({ network: null, networkRaw: 'mystery-chain', amount: '1', asset: USDC }, A).reason, /unknown v1 network/);
});

test('parseSettlement reads PAYMENT-RESPONSE and X-PAYMENT-RESPONSE', () => {
  const s = parseSettlement(new Headers({ 'PAYMENT-RESPONSE': toB64json({ success: true, transaction: '', network: 'eip155:84532', amount: '120' }) }));
  assert.deepEqual([s.success, s.amount], [true, '120']);
  assert.equal(parseSettlement(new Headers({ 'X-PAYMENT-RESPONSE': toB64json({ success: false, errorReason: 'x', transaction: '', network: 'base-sepolia' }) })).success, false);
  assert.equal(parseSettlement(new Headers()), null);
  assert.equal(parseSettlement(new Headers({ 'PAYMENT-RESPONSE': 'garbage!!' })), null);
});

test('SPEC pins the commit the formats were read from', () => {
  assert.match(SPEC.commit, /^0e6e8c5/);
  assert.deepEqual(SPEC.versions, [1, 2]);
});
