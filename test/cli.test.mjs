import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { main, makeHandler } from '../src/cli.mjs';
import { toB64json } from '../src/x402.mjs';
import { mockX402 } from '../src/mock.mjs';
import { SNAP, SNAP_FILE, spec, USDC } from './helpers.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const run = async (args, o = {}) => { const lines = []; const code = await main(args, { out: (s) => lines.push(s), env: {}, ...o }); return { code, out: lines.join('\n') }; };
const tmp = () => mkdtempSync(join(tmpdir(), 'x402pc-'));
const v2 = (amount, scheme = 'exact') => toB64json({ x402Version: 2, resource: { url: 'http://mock.test/v1/chat/completions' }, accepts: [{ scheme, network: 'eip155:84532', amount, asset: USDC, payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 60 }] });
const DSA = ['--model', 'deepseek/deepseek-v4.1-flash', '--input-tokens', '2000', '--max-tokens', '1000', '--snapshot', SNAP_FILE];

test('check: exit 0 approve, 1 reject, 2 bad input', async () => {
  const a = await run(['check', '--quote', v2('350'), ...DSA]);
  assert.equal(a.code, 0);
  assert.match(a.out, /^APPROVE {2}\$0\.00035 USDC on eip155:84532 \(exact\) vs cheapest list \$0\.0003042/);
  assert.match(a.out, /premium 15\.06% \(max 25%\)/);
  const r = await run(['check', '--quote', v2('5000'), ...DSA]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^REJECT/);
  assert.equal((await run(['check', '--quote', v2('350'), '--model', 'x', '--snapshot', SNAP_FILE])).code, 2);
  assert.match((await run(['check', '--quote', v2('350'), '--bogus', '1'])).out, /unknown option --bogus/);
  assert.equal((await run(['check', '--quote', 'notbase64!!', ...DSA])).code, 2);
});

test('check: spec v1 body from a file, MCP result from stdin, --json', async () => {
  const d = tmp();
  writeFileSync(join(d, 'v1.json'), spec('v1-payment-required.json'));
  const v1 = await run(['check', '--quote', join(d, 'v1.json'), ...DSA, '--json']);
  const j = JSON.parse(v1.out);
  assert.equal(j.x402Version, 1);
  assert.equal(j.quote.usd, '0.01'); // the spec example asks 10000 atomic USDC
  assert.equal(v1.code, 1); // $0.01 for $0.0003 of tokens
  const m = await run(['check', '--quote', '-', ...DSA, '--max-premium', '5000'], { stdin: () => spec('mcp-tool-result.json') });
  assert.equal(m.code, 0);
});

test('check with --body and a budget: hold, status, release on the ledger', async () => {
  const d = tmp();
  const ledger = join(d, 'ledger.jsonl');
  writeFileSync(join(d, 'req.json'), JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 }));
  const a = await run(['check', '--quote', v2('250'), '--body', join(d, 'req.json'), '--snapshot', SNAP_FILE, '--max-day', '0.01', '--ledger', ledger, '--json']);
  const j = JSON.parse(a.out);
  assert.equal(a.code, 0);
  assert.match(j.tokens.inputBasis, /bytes/);
  assert.ok(j.budget.hold);
  assert.equal(statSync(ledger).mode & 0o777, 0o600);
  const st = JSON.parse((await run(['status', '--ledger', ledger, '--max-day', '0.01'])).out);
  assert.equal(st.open.length, 1);
  assert.equal((await run(['release', '--id', j.budget.hold, '--ledger', ledger, '--max-day', '0.01'])).code, 0);
  const over = await run(['check', '--quote', v2('250'), '--body', join(d, 'req.json'), '--snapshot', SNAP_FILE, '--max-call', '0.0001', '--ledger', ledger]);
  assert.equal(over.code, 1);
  assert.match(over.out, /spendcap:/);
});

test('probe asks a mock endpoint for its quote and never pays', async () => {
  const m = await mockX402({ amount: '350' });
  try {
    const d = tmp();
    writeFileSync(join(d, 'req.json'), JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [], max_tokens: 1000 }));
    const p = await run(['probe', `${m.url}/v2/chat/completions`, '--body', join(d, 'req.json'), '--input-tokens', '2000', '--snapshot', SNAP_FILE]);
    assert.equal(p.code, 0, p.out);
    const p1 = await run(['probe', `${m.url}/v1/chat/completions`, '--body', join(d, 'req.json'), '--input-tokens', '2000', '--snapshot', SNAP_FILE]);
    assert.equal(p1.code, 0, p1.out);
    assert.ok(m.calls.every((c) => !c.paid));
    assert.equal((await run(['probe', 'ftp://x', '--model', 'm'])).code, 2);
  } finally { await m.close(); }
});

test('the bin runs through a symlink (as npx does)', () => {
  const d = tmp();
  const link = join(d, 'x402-price-check');
  symlinkSync(CLI, link);
  const r = spawnSync(link, ['check', '--quote', v2('350'), ...DSA], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^APPROVE/);
  assert.match(spawnSync(link, ['--help'], { encoding: 'utf8' }).stdout, /x402 v2 and v1/);
});

test('MCP handler: tools/list and x402_price_check on the spec MCP example', async () => {
  const h = makeHandler({ getSnapshot: async () => SNAP });
  const list = await h({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['x402_price_check', 'x402_settle', 'x402_release', 'x402_budget']);
  const call = await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x402_price_check', arguments: { quote: JSON.parse(spec('mcp-tool-result.json')), request: { model: 'deepseek/deepseek-v4.1-flash', inputTokens: 2000, maxOutputTokens: 1000 } } } });
  assert.equal(call.result.structuredContent.verdict, 'reject');
  assert.equal(call.result.isError, false);
  const bad = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x402_price_check', arguments: { quote: 'zz!!' } } });
  assert.equal(bad.result.isError, true);
  assert.equal((await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'x402_settle', arguments: { id: 'a', usd: '1' } } })).result.isError, true);
});

test('mcp over stdio', async () => {
  const p = spawn(process.execPath, [CLI, 'mcp', '--snapshot', SNAP_FILE], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  p.stdout.on('data', (c) => { buf += c; });
  const req = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  req({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  req({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x402_price_check', arguments: { quote: v2('350'), body: { model: 'deepseek/deepseek-v4.1-flash', messages: [], max_tokens: 1000 }, request: { inputTokens: 2000 } } } });
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  const [init, res] = buf.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(init.result.serverInfo.name, 'x402-price-check');
  assert.equal(res.result.structuredContent.verdict, 'approve');
});

test('demo: one mock quote paid with a mock payment, one refused', async () => {
  const d = await run(['demo', '--snapshot', SNAP_FILE]);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /APPROVE[^\n]+premium 10\.13%/);
  assert.match(d.out, /paid with a MOCK payment: HTTP 200/);
  assert.match(d.out, /REJECT[^\n]+premium 200\.14%/);
  assert.match(d.out, /endpoint saw 0 paid requests/);
  assert.doesNotMatch(d.out, /settle or release/);
});
