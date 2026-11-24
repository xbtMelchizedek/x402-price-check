import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpendCap, parsePolicy, memoryLedger } from 'agent-spendcap';
import { guardedFetch, PaymentRefused, check } from '../src/guard.mjs';
import { mockX402, mockPay } from '../src/mock.mjs';
import { SNAP, DS, quoteOf } from './helpers.mjs';

const capOf = (perCallMax = '0.01', max = '1') => new SpendCap({ policy: parsePolicy({ version: 1, perCallMax, windows: [{ name: 'day', seconds: 86400, max }] }), ledger: memoryLedger() });
const post = { method: 'POST', body: '{}' };

async function withMock(opts, fn) {
  const m = await mockX402(opts);
  try { await fn(m); } finally { await m.close(); }
}

test('v2: approved quote is paid with the mock payment, hold settled at the quote', () => withMock({ amount: '350' }, async (m) => {
  const cap = capOf();
  const res = await guardedFetch(`${m.url}/v2/chat/completions`, post, { request: DS, snapshot: SNAP, cap, pay: mockPay });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, 'mock reply');
  assert.equal(res.x402.result.verdict, 'approve');
  assert.equal(res.x402.paidUsd, '0.00035');
  assert.deepEqual(m.calls.map((c) => c.paid), [false, true]);
  const st = cap.status();
  assert.equal(st.windows[0].usedUsd, '0.00035');
  assert.equal(st.open.length, 0);
}));

test('v1: body quote, X-PAYMENT header, X-PAYMENT-RESPONSE read', () => withMock({ amount: '330' }, async (m) => {
  const res = await guardedFetch(`${m.url}/v1/chat/completions`, post, { request: DS, snapshot: SNAP, cap: capOf(), pay: mockPay });
  assert.equal(res.status, 200);
  assert.equal(res.x402.result.x402Version, 1);
  assert.equal(res.x402.settlement.success, true);
}));

test('overpriced quote: PaymentRefused, pay() never called, nothing sent', () => withMock({ amount: '5000' }, async (m) => {
  let paid = 0;
  await assert.rejects(guardedFetch(`${m.url}/v2/chat/completions`, post, { request: DS, snapshot: SNAP, pay: () => { paid++; return 'x'; } }),
    (e) => e instanceof PaymentRefused && /over the cheapest list price/.test(e.message) && e.result.premiumPct !== null);
  assert.equal(paid, 0);
  assert.deepEqual(m.calls.map((c) => c.paid), [false]);
}));

test('fair price but over budget: refused by agent-spendcap', () => withMock({ amount: '350' }, async (m) => {
  const cap = capOf('0.0003');
  await assert.rejects(guardedFetch(`${m.url}/v2/chat/completions`, post, { request: DS, snapshot: SNAP, cap, pay: mockPay }),
    (e) => e instanceof PaymentRefused && e.result.reasons.some((r) => r.startsWith('spendcap:')));
  assert.equal(m.calls.length, 1);
  assert.equal(cap.status().denied, 1);
}));

test('upto: settles the amount the server reports, not the ceiling', () => withMock({ amount: '350', scheme: 'upto', settleAmount: '120' }, async (m) => {
  const cap = capOf();
  const res = await guardedFetch(`${m.url}/v2/chat/completions`, post, { request: DS, snapshot: SNAP, cap, pay: mockPay });
  assert.equal(res.x402.paidUsd, '0.00012');
  assert.equal(cap.status().windows[0].usedUsd, '0.00012');
}));

test('settlement failure releases the hold', () => withMock({ amount: '350', failSettle: true }, async (m) => {
  const cap = capOf();
  const res = await guardedFetch(`${m.url}/v2/chat/completions`, post, { request: DS, snapshot: SNAP, cap, pay: mockPay });
  assert.equal(res.status, 402);
  assert.equal(res.x402.settlement.success, false);
  assert.equal(cap.status().windows[0].usedUsd, '0');
  assert.equal(cap.status().open.length, 0);
}));

test('pay() failing releases the hold; non-402 responses pass straight through', () => withMock({ amount: '350' }, async (m) => {
  const cap = capOf();
  await assert.rejects(guardedFetch(`${m.url}/v2/chat/completions`, post, { request: DS, snapshot: SNAP, cap, pay: () => { throw new Error('wallet locked'); } }), /wallet locked/);
  assert.equal(cap.status().open.length, 0);
  const plain = await guardedFetch('http://x.test/', {}, { request: DS, snapshot: SNAP, fetch: async () => new Response('hi', { status: 200 }), pay: mockPay });
  assert.equal(plain.x402, null);
}));

test('check(): $0 quotes need no hold', () => {
  const r = check(quoteOf(['0']), DS, { snapshot: SNAP, cap: capOf() });
  assert.equal(r.verdict, 'approve');
  assert.equal(r.budget.hold, null);
});

test('the paid retry refuses redirects, so a payment header never follows to another URL', () => withMock({ amount: '350' }, async (m) => {
  const seen = [];
  const f = (u, init) => { seen.push(init.redirect ?? 'follow'); return fetch(u, init); };
  await guardedFetch(`${m.url}/v2/chat/completions`, post, { request: DS, snapshot: SNAP, pay: mockPay, fetch: f });
  assert.deepEqual(seen, ['follow', 'error']);
}));
