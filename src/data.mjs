import { readFileSync } from 'node:fs';
let cached;
/** USD-pegged assets from x402's SDK default tables (src/assets.json, see NOTICE). */
export function loadAssets() {
  cached ??= JSON.parse(readFileSync(new URL('./assets.json', import.meta.url), 'utf8'));
  return cached;
}

export { SNAPSHOT_URL } from 'justweight';

/** justweight snapshot from an https URL or a local file. */
export async function loadSnapshot(src, { fetchImpl = globalThis.fetch } = {}) {
  if (/^https:\/\//.test(src)) {
    const r = await fetchImpl(src, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`snapshot ${src}: HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(src, 'utf8'));
}
