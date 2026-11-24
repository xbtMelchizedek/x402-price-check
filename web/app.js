import { readPaymentRequired, toB64json } from './lib/x402.mjs';
import { evaluate, referencePrice, modelKey } from './lib/compare.mjs';

const SNAPSHOT_URL = 'https://xbtmelchizedek.github.io/justweight/data/snapshot.json';
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
let snapshot = null;
let assets = null;

async function load() {
  try {
    [snapshot, assets] = await Promise.all([
      fetch(SNAPSHOT_URL).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      fetch('lib/assets.json').then((r) => r.json()),
    ]);
    const keys = new Map();
    for (const o of snapshot.offers) if (o.unit === 'USD') keys.set(modelKey(o.model), keys.get(modelKey(o.model)) ?? o.model);
    for (const m of [...keys.values()].sort()) { const opt = el('option'); opt.value = m; $('models').append(opt); }
    $('snapnote').textContent = `Prices: justweight snapshot ${snapshot.generatedAt}, ${snapshot.offers.length} offers. USD-pegged assets: x402 defaults at ${assets.commit.slice(0, 7)}.`;
    run();
  } catch (e) {
    $('snapnote').textContent = `Could not load justweight prices (${e.message}). The check needs them.`;
  }
}

const req = () => ({ model: $('model').value.trim(), inputTokens: Number($('in').value), maxOutputTokens: Number($('out').value) });

function run() {
  const res = $('result');
  const tbl = $('opts');
  res.replaceChildren(); tbl.replaceChildren();
  if (!snapshot) return;
  const text = $('quote').value.trim();
  if (!text) { res.append(el('p', 'Paste a quote or pick an example.', 'muted')); return; }
  let r;
  try {
    const pr = readPaymentRequired(text, { v1Networks: assets.v1Networks });
    r = evaluate(pr, req(), { snapshot, assets: assets.networks, maxPremiumPct: $('prem').value.trim(), reference: $('ref').value });
  } catch (e) { res.append(el('p', e.message, 'bad')); return; }
  const head = el('p');
  const badge = el('span', undefined, `badge ${r.verdict === 'approve' ? 'success' : 'danger'}`);
  badge.append(el('span', undefined, 'badge-dot'), r.verdict === 'approve' ? 'Approve' : 'Reject');
  head.append(badge);
  const q = r.quote;
  head.append(` ${q ? `$${q.usd} ${q.symbol} on ${q.network} (${q.scheme}${q.ceiling ? ', ceiling' : ''})` : 'no priceable option'}`);
  if (r.reference) head.append(` vs ${r.reference.basis} list $${r.reference.usd}`);
  if (r.premiumPct !== null) head.append(`, premium ${r.premiumPct}% (max ${r.maxPremiumPct}%)`);
  res.append(head);
  if (r.reference) res.append(el('p', `Cheapest: ${r.reference.cheapest.provider} ${r.reference.cheapest.model} at $${r.reference.cheapest.inPer1M} in / $${r.reference.cheapest.outPer1M} out per 1M tokens. Median $${r.reference.medianUsd} of ${r.reference.listings} listings. ${r.spec}.`, 'muted'));
  for (const x of r.reasons) res.append(el('p', `– ${x}`, 'bad'));
  const hr = el('tr'); for (const h of ['#', 'Scheme', 'Network', 'Amount (atomic)', 'USD', 'Note']) hr.append(el('th', h));
  tbl.append(hr);
  for (const o of r.options) {
    const tr = el('tr');
    tr.append(el('td', String(o.index)), el('td', o.scheme), el('td', o.network), el('td', o.amount ?? '', 'num'), el('td', o.usd === null ? '–' : `$${o.usd}`, 'num'), el('td', o.reason ?? (q && o.index === q.index ? 'checked' : '')));
    tbl.append(tr);
  }
}

for (const b of $('examples').querySelectorAll('[data-ex]')) {
  b.addEventListener('click', async () => { $('quote').value = (await (await fetch(`examples/${b.dataset.ex}`)).text()).trim(); run(); });
}
$('fair').addEventListener('click', () => {
  if (!snapshot) return;
  const r = req();
  const ref = referencePrice(snapshot, r.model, r.inputTokens, r.maxOutputTokens);
  if (!ref) { $('result').replaceChildren(el('p', `justweight lists no USD price for ${r.model}.`, 'bad')); return; }
  const amount = String((ref.cheapest.nano * 110n + 99_999n) / 100_000n || 1n); // list +10%, USDC atomic (6 decimals)
  $('quote').value = toB64json({ x402Version: 2, error: 'PAYMENT-SIGNATURE header is required', resource: { url: 'https://example.invalid/v1/chat/completions', description: 'example quote at list +10%' }, accepts: [{ scheme: 'exact', network: 'eip155:84532', amount, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 60 }] });
  run();
});
for (const id of ['quote', 'model', 'in', 'out', 'prem', 'ref']) $(id).addEventListener('input', run);
$('go').addEventListener('click', run);
load();
