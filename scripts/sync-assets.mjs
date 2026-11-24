// Regenerate src/assets.json from a local clone of the x402 repo: the SDK's own default USD-pegged asset tables
// (typescript/packages/mechanisms/{evm,svm}/src/defaultAssets.ts), which x402 documents as the reverse lookup for
// client-side spend controls (DEFAULT_ASSETS.md). Run: node scripts/sync-assets.mjs /path/to/x402
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
if (!root) throw new Error('usage: node scripts/sync-assets.mjs /path/to/x402');
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const out = {};
for (const fam of ['evm', 'svm']) {
  const dir = `${root}/typescript/packages/mechanisms/${fam}/src`;
  const consts = {};
  for (const f of [`${dir}/constants.ts`, `${dir}/defaultAssets.ts`]) {
    let t = '';
    try { t = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of t.matchAll(/export const ([A-Z0-9_]+) = "([^"]+)";/g)) consts[m[1]] = m[2];
  }
  const src = readFileSync(`${dir}/defaultAssets.ts`, 'utf8');
  const body = src.slice(src.indexOf('DEFAULT_ASSETS'), src.indexOf('\n};', src.indexOf('DEFAULT_ASSETS')));
  const re = /(?:"([^"]+)"|\[([A-Z0-9_]+)\]):\s*\[([\s\S]*?)\n\s*\],/g;
  for (const m of body.matchAll(re)) {
    const net = m[1] ?? consts[m[2]];
    if (!net) throw new Error(`unknown network constant ${m[2]}`);
    for (const e of m[3].matchAll(/\{([\s\S]*?)\}/g)) {
      const f = e[1];
      const a = /asset:\s*(?:"([^"]+)"|([A-Z0-9_]+))/.exec(f);
      const asset = a?.[1] ?? consts[a?.[2]];
      const decimals = Number(/decimals:\s*(\d+)/.exec(f)?.[1]);
      const symbol = /symbol:\s*"([^"]+)"/.exec(f)?.[1];
      if (!asset || !Number.isSafeInteger(decimals) || !symbol) throw new Error(`could not parse an entry under ${net}`);
      (out[net] ??= []).push({ asset, decimals, symbol });
    }
  }
}
// v1 used plain network names ("base-sepolia"); the SDKs map them to CAIP-2.
const v1 = {};
const evmC = readFileSync(`${root}/typescript/packages/mechanisms/evm/src/constants.ts`, 'utf8');
const evmMap = evmC.slice(evmC.indexOf('EVM_NETWORK_CHAIN_ID_MAP'), evmC.indexOf('} as const', evmC.indexOf('EVM_NETWORK_CHAIN_ID_MAP')));
for (const m of evmMap.matchAll(/^\s*"?([a-z0-9-]+)"?:\s*(\d+),/gm)) v1[m[1]] = `eip155:${m[2]}`;
const svmC = readFileSync(`${root}/typescript/packages/mechanisms/svm/src/constants.ts`, 'utf8');
const svmConsts = Object.fromEntries([...svmC.matchAll(/export const ([A-Z0-9_]+) = "([^"]+)";/g)].map((m) => [m[1], m[2]]));
for (const m of svmC.matchAll(/^\s*"?(solana[a-z-]*)"?:\s*([A-Z0-9_]+),/gm)) if (svmConsts[m[2]]) v1[m[1]] = svmConsts[m[2]];
const n = Object.values(out).flat().length;
writeFileSync(new URL('../src/assets.json', import.meta.url), JSON.stringify({
  source: 'https://github.com/x402-foundation/x402 typescript/packages/mechanisms/{evm,svm}/src/defaultAssets.ts',
  commit, license: 'Apache-2.0 (x402); values copied as data, see NOTICE', usdPegged: true, v1Networks: v1, networks: out,
}, null, 1) + '\n');
console.log(`${Object.keys(out).length} networks, ${n} assets from ${commit.slice(0, 7)}`);
