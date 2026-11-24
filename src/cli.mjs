#!/usr/bin/env node
// x402-price-check CLI and MCP server. Checks quotes; never signs, never pays, holds no keys.
import { readFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { SpendCap, parsePolicy } from 'agent-spendcap';
import { fileLedger } from 'agent-spendcap/file';
import { readPaymentRequired, parsePaymentRequired, SPEC } from './x402.mjs';
import { requestFromBody, referencePrice } from './compare.mjs';
import { check, guardedFetch, PaymentRefused } from './guard.mjs';
import { mockX402, mockPay } from './mock.mjs';
import { memoryLedger } from 'agent-spendcap';
import { loadAssets, loadSnapshot, SNAPSHOT_URL } from './data.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const HELP = `x402-price-check ${VERSION}: is this x402 quote a fair price for the inference you asked for?

  x402-price-check demo                                               a local MOCK x402 endpoint: one fair quote, one overpriced
  x402-price-check check --quote <file|base64|-> (--body req.json | --model <id> --max-tokens <n> [--input-tokens <n> | --prompt-file <f>])
  x402-price-check probe <url> --body req.json [--method POST]       ask an endpoint for its 402 quote; never pays
  x402-price-check status | settle --id <hold> --usd <paid> | release --id <hold>
  x402-price-check mcp                                                stdio MCP server (x402_price_check, x402_settle, x402_release, x402_budget)

  --max-premium <pct>     most you will pay over the list price, default 25
  --reference cheapest|median   compare with the cheapest list price (default) or the median
  --allow-unlisted        approve models justweight has no price for (budget still applies)
  --max-call <usd> --max-day <usd> | --policy <agent-spendcap policy.json>   budget; places a hold on approve
  --ledger <file>         default ~/.x402-price-check/ledger.jsonl
  --snapshot <url|file>   default ${SNAPSHOT_URL}
  --json                  full result as JSON

--quote takes a v2 PAYMENT-REQUIRED header value, a v1 402 JSON body, a PaymentRequired object or an MCP tool result.
Spec: x402 v2 and v1, ${SPEC.repo} @ ${SPEC.commit.slice(0, 7)}.
Exit codes: 0 approve, 1 reject, 2 bad input.`;

const BOOL = new Set(['allow-unlisted', 'json', 'help']);
const VAL = new Set(['quote', 'body', 'model', 'max-tokens', 'input-tokens', 'prompt-file', 'max-premium', 'reference', 'max-call', 'max-day', 'policy', 'ledger', 'snapshot', 'method', 'id', 'usd']);
export class UsageError extends Error {}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) o[k] = true;
    else if (VAL.has(k)) { if (rest[i + 1] === undefined) throw new UsageError(`${a} needs a value`); o[k] = rest[++i]; }
    else throw new UsageError(`unknown option ${a}`);
  }
  return { cmd, o };
}

const DEC = /^\d+(\.\d{1,9})?$/;
const usdFlag = (v, name) => {
  if (v === undefined) return undefined;
  if (!DEC.test(v) || Number(v) === 0) throw new UsageError(`${name} must be a USD amount above 0, e.g. 0.05`);
  return v;
};
const intFlag = (v, name) => {
  if (v === undefined) return undefined;
  if (!/^\d{1,9}$/.test(v)) throw new UsageError(`${name} must be a whole number`);
  return Number(v);
};

export function budgetPolicy(o) {
  if (o.policy) return parsePolicy(JSON.parse(readFileSync(o.policy, 'utf8')));
  const maxCall = usdFlag(o['max-call'], '--max-call'); const maxDay = usdFlag(o['max-day'], '--max-day');
  if (maxCall === undefined && maxDay === undefined) return null;
  return parsePolicy({ version: 1, perCallMax: maxCall ?? maxDay, windows: [{ name: 'day', seconds: 86400, max: maxDay ?? '1000000000' }] });
}

function openCap(o, env, { needPolicy = false } = {}) {
  const policy = budgetPolicy(o) ?? (needPolicy ? parsePolicy({ version: 1, perCallMax: '1000000000', windows: [{ name: 'day', seconds: 86400, max: '1000000000' }] }) : null);
  if (!policy) return null;
  const path = o.ledger ?? env.X402_PRICE_CHECK_LEDGER ?? join(homedir(), '.x402-price-check', 'ledger.jsonl');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const ledger = fileLedger(path);
  return { cap: new SpendCap({ policy, ledger }), ledger };
}

function readRequest(o) {
  if (o.body) {
    const body = JSON.parse(readFileSync(o.body, 'utf8'));
    const r = requestFromBody(body, { inputTokens: intFlag(o['input-tokens'], '--input-tokens') });
    if (o['max-tokens'] !== undefined) r.maxOutputTokens = intFlag(o['max-tokens'], '--max-tokens');
    if (o.model) r.model = o.model;
    return r;
  }
  if (!o.model) throw new UsageError('pass --body <request.json> or --model <id> --max-tokens <n>');
  return { model: o.model, maxOutputTokens: intFlag(o['max-tokens'], '--max-tokens'), inputTokens: intFlag(o['input-tokens'], '--input-tokens'), input: o['prompt-file'] ? readFileSync(o['prompt-file'], 'utf8') : undefined };
}

function readQuote(q, stdin) {
  if (q === undefined) throw new UsageError('pass --quote <file|base64|->');
  const text = q === '-' ? stdin() : existsSync(q) ? readFileSync(q, 'utf8') : q;
  return readPaymentRequired(text, { v1Networks: loadAssets().v1Networks });
}

export function summary(r, { held = true } = {}) {
  const lines = [];
  const q = r.quote;
  const ref = r.reference;
  lines.push(`${r.verdict.toUpperCase()}  ${q ? `$${q.usd} ${q.symbol} on ${q.network} (${q.scheme}${q.ceiling ? ', ceiling' : ''})` : 'no priceable option'}` +
    (ref ? ` vs ${ref.basis} list $${ref.usd} (${ref.cheapest.provider} ${ref.cheapest.model}; median $${ref.medianUsd} of ${ref.listings})` : '') +
    (r.premiumPct !== null ? `, premium ${r.premiumPct}% (max ${r.maxPremiumPct}%)` : ''));
  lines.push(`  tokens: ${r.tokens.input} in (${r.tokens.inputBasis}), ${r.tokens.output} out max; ${r.spec}`);
  if (held && r.budget?.ok && r.budget.hold) lines.push(`  hold ${r.budget.hold} for $${r.budget.reservedUsd}: settle or release it after the call`);
  for (const x of r.reasons) lines.push(`  - ${x}`);
  return lines.join('\n');
}

async function snapshotFor(o, env, fetchImpl) {
  return loadSnapshot(o.snapshot ?? env.X402_PRICE_CHECK_SNAPSHOT ?? SNAPSHOT_URL, { fetchImpl });
}

export async function main(argv, { out = console.log, env = process.env, fetchImpl = globalThis.fetch, stdin = () => readFileSync(0, 'utf8') } = {}) {
  let opened = null;
  try {
    const { cmd, o } = parseArgs(argv);
    if (!cmd || cmd === 'help' || cmd === '--help' || o.help) { out(HELP); return cmd ? 0 : 2; }
    if (cmd === 'mcp') return await serveMcp(o, env, fetchImpl);
    if (cmd === 'demo') return await demo(o, env, fetchImpl, out);
    if (cmd === 'status' || cmd === 'settle' || cmd === 'release') {
      opened = openCap(o, env, { needPolicy: true });
      const { cap } = opened;
      if (cmd === 'status') out(JSON.stringify(cap.status(), null, 1));
      else if (cmd === 'settle') out(JSON.stringify(cap.settle(o.id, usdFlag(o.usd, '--usd') ?? '0')));
      else out(JSON.stringify(cap.release(o.id)));
      return 0;
    }
    let pr;
    let request;
    if (cmd === 'check') { pr = readQuote(o.quote, stdin); request = readRequest(o); }
    else if (cmd === 'probe') {
      const url = o._[0];
      if (!/^https?:\/\//.test(url ?? '')) throw new UsageError('probe needs an http(s) URL');
      request = readRequest(o);
      const body = o.body ? readFileSync(o.body, 'utf8') : undefined;
      const res = await fetchImpl(url, { method: o.method ?? (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body, signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (res.status !== 402) { out(`${url} answered HTTP ${res.status}, not 402 Payment Required: nothing to check`); return 2; }
      pr = parsePaymentRequired({ status: 402, headers: res.headers, bodyText: text }, { v1Networks: loadAssets().v1Networks });
    } else throw new UsageError(`unknown command ${cmd}\n\n${HELP}`);
    const snapshot = await snapshotFor(o, env, fetchImpl);
    opened = openCap(o, env);
    const r = check(pr, request, { snapshot, cap: opened?.cap ?? null, maxPremiumPct: o['max-premium'] ?? '25', reference: o.reference ?? 'cheapest', allowUnlisted: !!o['allow-unlisted'] });
    out(o.json ? JSON.stringify(r, null, 1) : summary(r));
    return r.verdict === 'approve' ? 0 : 1;
  } catch (e) {
    out(`x402-price-check: ${e.message}`);
    return 2;
  } finally {
    opened?.ledger.close();
  }
}

async function demo(o, env, fetchImpl, out) {
  const snapshot = await snapshotFor(o, env, fetchImpl);
  const request = { model: o.model ?? 'deepseek/deepseek-v4.1-flash', inputTokens: 2000, maxOutputTokens: 1000 };
  const ref = referencePrice(snapshot, request.model, request.inputTokens, request.maxOutputTokens);
  if (!ref) throw new UsageError(`justweight lists no USD price for ${request.model}; try --model deepseek/deepseek-v4.1-flash`);
  const atomic = (num, den) => String((ref.cheapest.nano * num + den * 1000n - 1n) / (den * 1000n) || 1n); // USDC has 6 decimals
  const cap = new SpendCap({ policy: parsePolicy({ version: 1, perCallMax: '0.01', windows: [{ name: 'day', seconds: 86400, max: '0.05' }] }), ledger: memoryLedger() });
  out(`Demo: a local MOCK x402 endpoint (v2 HTTP, Base Sepolia USDC terms, mock payments only: nothing is signed or sent on chain).`);
  out(`Request: ${request.model}, ${request.inputTokens} tokens in, up to ${request.maxOutputTokens} out. Budget: $0.01 a call, $0.05 a day (in memory).\n`);
  for (const [label, amount] of [['quotes list price +10%', atomic(110n, 100n)], ['quotes 3x list price', atomic(3n, 1n)]]) {
    const m = await mockX402({ amount });
    try {
      out(`Mock endpoint ${label}:`);
      try {
        const res = await guardedFetch(`${m.url}/v2/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: request.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 }) }, { request, snapshot, cap, pay: mockPay, fetch: fetchImpl });
        out(summary(res.x402.result, { held: false }));
        out(`  -> paid with a MOCK payment: HTTP ${res.status}, $${res.x402.paidUsd} settled on the demo budget\n`);
      } catch (e) {
        if (!(e instanceof PaymentRefused)) throw e;
        out(summary(e.result));
        out(`  -> refused: nothing was paid (endpoint saw ${m.calls.filter((c) => c.paid).length} paid requests)\n`);
      }
    } finally { await m.close(); }
  }
  out(`Prices: justweight snapshot ${snapshot.generatedAt ?? ''}. Your turn: x402-price-check probe <url> --body request.json`);
  return 0;
}

export const TOOLS = [
  { name: 'x402_price_check', description: 'Before paying an x402 402 Payment Required quote for inference, check it: compares the quoted price with justweight list prices for the model and token count, applies the max premium and the budget. Approve means you may pay; it never pays for you. If a hold id comes back, call x402_settle or x402_release after the call.',
    inputSchema: { type: 'object', required: ['quote'], properties: {
      quote: { description: 'The 402: a v2 PAYMENT-REQUIRED header value (base64), a v1 402 JSON body, a PaymentRequired object, or an MCP tool result with structuredContent', anyOf: [{ type: 'string' }, { type: 'object' }] },
      request: { type: 'object', description: 'What you will ask for', required: ['model', 'maxOutputTokens'], properties: { model: { type: 'string' }, maxOutputTokens: { type: 'integer' }, inputTokens: { type: 'integer' }, input: { type: 'string', description: 'prompt text, if inputTokens is unknown (bytes bound the tokens)' } } },
      body: { type: 'object', description: 'Or the OpenAI/Anthropic-style request body you will send' },
      maxPremiumPct: { type: 'string', description: 'Default from the server, normally "25"' },
      reference: { type: 'string', enum: ['cheapest', 'median'] } } } },
  { name: 'x402_settle', description: 'Record what a held payment actually cost (the settled amount for upto, else the quote).', inputSchema: { type: 'object', required: ['id', 'usd'], properties: { id: { type: 'string' }, usd: { type: 'string' } } } },
  { name: 'x402_release', description: 'You did not pay: give the hold back.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'x402_budget', description: 'Spent and remaining per budget window, open holds.', inputSchema: { type: 'object', properties: {} } },
];

/** MCP handler. getSnapshot() returns a justweight snapshot; cap is optional. Exported for tests. */
export function makeHandler({ getSnapshot, cap = null, defaults = {} }) {
  const text = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }], structuredContent: obj, isError });
  const v1Networks = loadAssets().v1Networks;
  return async (msg) => {
    const { id, method, params } = msg ?? {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'x402-price-check', version: VERSION } });
    if (method?.startsWith('notifications/')) return null;
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const a = params?.arguments ?? {};
      try {
        switch (params?.name) {
          case 'x402_price_check': {
            const pr = readPaymentRequired(a.quote, { v1Networks });
            const request = a.body ? requestFromBody(a.body, { inputTokens: a.request?.inputTokens }) : a.request;
            const r = check(pr, request, { snapshot: await getSnapshot(), cap, maxPremiumPct: a.maxPremiumPct ?? defaults.maxPremiumPct ?? '25', reference: a.reference ?? defaults.reference ?? 'cheapest', allowUnlisted: !!defaults.allowUnlisted });
            return reply(text(r));
          }
          case 'x402_settle': if (!cap) throw new Error('no budget configured (start with --max-day, --max-call or --policy)'); return reply(text(cap.settle(a.id, a.usd)));
          case 'x402_release': if (!cap) throw new Error('no budget configured'); return reply(text(cap.release(a.id)));
          case 'x402_budget': return reply(text(cap ? cap.status() : { budget: 'none configured' }));
          default: return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
        }
      } catch (e) {
        return reply(text({ ok: false, error: e.message }, true));
      }
    }
    return id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  };
}

async function serveMcp(o, env, fetchImpl) {
  const opened = openCap(o, env);
  let snap = null; let at = 0;
  const getSnapshot = async () => {
    if (!snap || Date.now() - at > 15 * 60_000) { snap = await snapshotFor(o, env, fetchImpl); at = Date.now(); }
    return snap;
  };
  const handle = makeHandler({ getSnapshot, cap: opened?.cap ?? null, defaults: { maxPremiumPct: o['max-premium'], reference: o.reference, allowUnlisted: !!o['allow-unlisted'] } });
  const rl = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain.then(async () => {
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
      const res = await handle(msg);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    });
  });
  return new Promise((resolve) => rl.on('close', () => chain.then(() => { opened?.ledger.close(); resolve(0); })));
}

function isEntry() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isEntry()) main(process.argv.slice(2)).then((c) => process.exit(c));
