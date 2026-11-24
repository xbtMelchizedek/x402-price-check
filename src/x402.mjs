// x402 wire formats, parsed to one shape. Browser-safe (no node: imports).
// Spec: x402 Protocol Specification v2 (version history: v2.0, 2025-12-9) and v1, plus the HTTP transports, at
// https://github.com/x402-foundation/x402/tree/0e6e8c55d86b4f14234fb6e49a4052074fb93e57/specs
//  - v2 HTTP: status 402, PaymentRequired as base64 JSON in the PAYMENT-REQUIRED header; accepts[].amount;
//    network in CAIP-2; settlement result in PAYMENT-RESPONSE (base64 SettlementResponse, optional `amount`).
//  - v1 HTTP: status 402, PaymentRequirementsResponse as the JSON body; accepts[].maxAmountRequired; network as a
//    plain name ("base-sepolia"); settlement in X-PAYMENT-RESPONSE.
//  - MCP transport: the same PaymentRequired object in a tool result's structuredContent.

export const SPEC = {
  name: 'x402',
  versions: [1, 2],
  repo: 'https://github.com/x402-foundation/x402',
  commit: '0e6e8c55d86b4f14234fb6e49a4052074fb93e57',
  docs: ['specs/x402-specification-v2.md', 'specs/x402-specification-v1.md', 'specs/transports-v2/http.md', 'specs/transports-v1/http.md', 'specs/transports-v2/mcp.md'],
};

export class X402FormatError extends Error {
  constructor(msg) { super(`x402: ${msg}`); this.name = 'X402FormatError'; }
}

const INT = /^\d{1,78}$/;
const str = (v, max = 2048) => typeof v === 'string' && v.length > 0 && v.length <= max;

export function b64json(s) {
  if (typeof s !== 'string' || s.length > 64 * 1024 || !/^[A-Za-z0-9+/=_-]+$/.test(s.trim())) throw new X402FormatError('header is not base64');
  let text;
  try {
    const bin = atob(s.trim().replace(/-/g, '+').replace(/_/g, '/'));
    text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { throw new X402FormatError('header is not base64'); }
  try { return JSON.parse(text); } catch { throw new X402FormatError('header is not base64 JSON'); }
}

export const toB64json = (o) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))));

/** Normalize a v1 or v2 PaymentRequired object. v1 network names map to CAIP-2 through `v1Networks`. */
export function normalizePaymentRequired(o, { v1Networks = {} } = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new X402FormatError('PaymentRequired must be an object');
  const v = o.x402Version;
  if (v !== 1 && v !== 2) throw new X402FormatError(`unsupported x402Version ${JSON.stringify(v)} (this reads 1 and 2)`);
  if (!Array.isArray(o.accepts) || o.accepts.length === 0 || o.accepts.length > 32) throw new X402FormatError('accepts must list 1 to 32 payment options');
  const accepts = o.accepts.map((a, i) => {
    const f = `accepts[${i}]`;
    if (!a || typeof a !== 'object') throw new X402FormatError(`${f} must be an object`);
    const amount = v === 2 ? a.amount : a.maxAmountRequired;
    const amountField = v === 2 ? 'amount' : 'maxAmountRequired';
    if (!str(a.scheme, 64)) throw new X402FormatError(`${f}.scheme is required`);
    if (!str(a.network, 128)) throw new X402FormatError(`${f}.network is required`);
    if (typeof amount !== 'string' || !INT.test(amount)) throw new X402FormatError(`${f}.${amountField} must be a string of atomic units`);
    if (!str(a.asset, 128)) throw new X402FormatError(`${f}.asset is required`);
    if (!str(a.payTo, 128)) throw new X402FormatError(`${f}.payTo is required`);
    if (!Number.isSafeInteger(a.maxTimeoutSeconds) || a.maxTimeoutSeconds < 0) throw new X402FormatError(`${f}.maxTimeoutSeconds must be a whole number`);
    const network = v === 1 && !a.network.includes(':') ? (v1Networks[a.network] ?? null) : a.network;
    return { index: i, scheme: a.scheme, network, networkRaw: a.network, amount, asset: a.asset, payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds, extra: a.extra && typeof a.extra === 'object' ? a.extra : {}, raw: a };
  });
  let resource;
  if (v === 2) {
    if (!o.resource || !str(o.resource.url)) throw new X402FormatError('resource.url is required in v2');
    resource = { url: o.resource.url, description: o.resource.description ?? null, mimeType: o.resource.mimeType ?? null, serviceName: o.resource.serviceName ?? null };
  } else {
    const a0 = o.accepts[0];
    resource = { url: str(a0.resource) ? a0.resource : null, description: a0.description ?? null, mimeType: a0.mimeType ?? null, serviceName: null };
  }
  return { version: v, error: typeof o.error === 'string' ? o.error.slice(0, 500) : null, resource, accepts, extensions: o.extensions ?? {} };
}

/**
 * From an HTTP response: v2 PAYMENT-REQUIRED header first (the spec's canonical location), else a v1 JSON body.
 * `headers` is a Headers-like object or a plain object; `bodyText` the response body as text.
 */
export function parsePaymentRequired({ status, headers, bodyText }, opts) {
  if (status !== 402) throw new X402FormatError(`expected HTTP 402, got ${status}`);
  const get = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k] ?? headers?.[k.toLowerCase()]);
  const h = get('PAYMENT-REQUIRED') ?? get('payment-required');
  if (h) return { ...normalizePaymentRequired(b64json(h), opts), transport: 'http-header' };
  let body;
  try { body = JSON.parse(bodyText ?? ''); } catch { throw new X402FormatError('402 without a PAYMENT-REQUIRED header or a JSON body'); }
  return { ...normalizePaymentRequired(body, opts), transport: 'http-body' };
}

/** v2 PAYMENT-RESPONSE or v1 X-PAYMENT-RESPONSE: { success, transaction, network, amount? }. Null if absent or bad. */
export function parseSettlement(headers) {
  const get = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k.toLowerCase()]);
  const h = get('PAYMENT-RESPONSE') ?? get('X-PAYMENT-RESPONSE');
  if (!h) return null;
  try {
    const s = b64json(h);
    if (typeof s.success !== 'boolean') return null;
    return { success: s.success, transaction: typeof s.transaction === 'string' ? s.transaction : null, network: s.network ?? null, amount: typeof s.amount === 'string' && INT.test(s.amount) ? s.amount : null, errorReason: s.errorReason ?? null };
  } catch { return null; }
}

/**
 * Price an option in USD when its asset is a USD-pegged default x402 itself lists (the SDK's reverse lookup used for
 * client spend controls). Returns { nano, symbol, decimals } or { nano: null, reason }.
 */
export function usdOf(opt, assets) {
  if (!opt.network) return { nano: null, reason: `unknown v1 network ${opt.networkRaw}` };
  const list = assets?.[opt.network] ?? [];
  const evm = opt.network.startsWith('eip155:');
  const hit = list.find((x) => (evm ? x.asset.toLowerCase() === opt.asset.toLowerCase() : x.asset === opt.asset));
  if (!hit) return { nano: null, reason: `${opt.asset} on ${opt.network} is not a USD-pegged asset in x402's default asset table` };
  const amt = BigInt(opt.amount);
  const scale = 10n ** BigInt(hit.decimals);
  const nano = (amt * 1_000_000_000n + scale - 1n) / scale; // round up: never understate a price
  return { nano, symbol: hit.symbol, decimals: hit.decimals };
}

/** MCP transport: a tool result with isError: true and PaymentRequired in structuredContent (or content[0].text). */
export function parseMcpPaymentRequired(result, opts) {
  if (!result || typeof result !== 'object') throw new X402FormatError('MCP tool result must be an object');
  const is = (o) => o && typeof o === 'object' && 'x402Version' in o && Array.isArray(o.accepts);
  let o = is(result.structuredContent) ? result.structuredContent : null;
  if (!o && Array.isArray(result.content) && result.content[0]?.type === 'text') {
    try { const t = JSON.parse(result.content[0].text); if (is(t)) o = t; } catch { /* not JSON */ }
  }
  if (!o) throw new X402FormatError('MCP tool result carries no PaymentRequired (structuredContent or content[0].text)');
  return { ...normalizePaymentRequired(o, opts), transport: 'mcp' };
}

/** Any of: an HTTP response shape, an MCP tool result, a PaymentRequired object, or a base64 PAYMENT-REQUIRED value. */
export function readPaymentRequired(x, opts) {
  if (typeof x === 'string') {
    const s = x.trim();
    if (s.startsWith('{')) { let o; try { o = JSON.parse(s); } catch { throw new X402FormatError('not valid JSON'); } return readPaymentRequired(o, opts); }
    let o;
    try { o = b64json(s); } catch { throw new X402FormatError('expected a base64 PAYMENT-REQUIRED value or JSON'); }
    return { ...normalizePaymentRequired(o, opts), transport: 'http-header' };
  }
  if (x && typeof x === 'object' && ('structuredContent' in x || 'content' in x)) return parseMcpPaymentRequired(x, opts);
  if (x && typeof x === 'object' && 'status' in x && 'headers' in x) return parsePaymentRequired(x, opts);
  return { ...normalizePaymentRequired(x, opts), transport: x?.x402Version === 1 ? 'http-body' : 'object' };
}
