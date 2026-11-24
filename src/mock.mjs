// A MOCK x402 inference endpoint, for tests and the demo. Speaks the v2 and v1 HTTP transports; accepts only mock payments
// ({ payload: { mock: true } }) and settles nothing: transaction is always "". No chain, no keys, no money.
import http from 'node:http';
import { toB64json, b64json } from './x402.mjs';

export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const PAY_TO = '0x000000000000000000000000000000000000dEaD'; // burn address placeholder, never paid

/** opts: { amount (atomic, 6-decimal USDC), scheme, asset, network, settleAmount, failSettle, extraAccepts } */
export function mockX402(opts = {}) {
  const calls = [];
  const req = (version) => {
    const base = { scheme: opts.scheme ?? 'exact', network: opts.network ?? (version === 2 ? 'eip155:84532' : 'base-sepolia'), asset: opts.asset ?? BASE_SEPOLIA_USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } };
    return version === 2 ? { ...base, amount: opts.amount ?? '350' } : { ...base, maxAmountRequired: opts.amount ?? '350', resource: 'http://mock/v1/chat/completions', description: 'mock chat', mimeType: 'application/json' };
  };
  const server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      const version = rq.url.startsWith('/v1/') ? 1 : 2;
      const sig = rq.headers[version === 2 ? 'payment-signature' : 'x-payment'];
      calls.push({ url: rq.url, paid: !!sig, body });
      const accepts = [...(opts.extraAccepts ?? []), req(version)];
      if (!sig) {
        const pr = version === 2
          ? { x402Version: 2, error: 'PAYMENT-SIGNATURE header is required', resource: { url: `http://${rq.headers.host}${rq.url}`, description: 'mock chat', mimeType: 'application/json' }, accepts }
          : { x402Version: 1, error: 'X-PAYMENT header is required', accepts };
        if (version === 2) { rs.writeHead(402, { 'PAYMENT-REQUIRED': toB64json(pr), 'content-type': 'application/json' }); rs.end('{}'); }
        else { rs.writeHead(402, { 'content-type': 'application/json' }); rs.end(JSON.stringify(pr)); }
        return;
      }
      let p;
      try { p = b64json(sig); } catch { rs.writeHead(400); rs.end('bad payment header'); return; }
      if (p?.payload?.mock !== true) { rs.writeHead(402); rs.end('mock server accepts mock payments only'); return; }
      const network = req(version).network;
      const s = opts.failSettle
        ? { success: false, errorReason: 'insufficient_funds', transaction: '', network }
        : { success: true, transaction: '', network, ...(opts.settleAmount ? { amount: opts.settleAmount } : {}) };
      rs.writeHead(opts.failSettle ? 402 : 200, { 'content-type': 'application/json', [version === 2 ? 'PAYMENT-RESPONSE' : 'X-PAYMENT-RESPONSE']: toB64json(s) });
      rs.end(JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', model: (() => { try { return JSON.parse(body).model ?? 'mock'; } catch { return 'mock'; } })(), choices: [{ index: 0, message: { role: 'assistant', content: 'mock reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

/** A mock pay(): builds a PaymentPayload-shaped object with no signature. Real clients sign here; this never does. */
export const mockPay = ({ option, paymentRequired }) => toB64json({ x402Version: paymentRequired.version, accepted: option, payload: { mock: true } });
