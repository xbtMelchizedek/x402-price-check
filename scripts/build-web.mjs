// Builds the Pages site into _site: web/ plus the browser-safe modules the in-page checker imports.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, '_site');
rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'web'), out, { recursive: true });
mkdirSync(join(out, 'lib'), { recursive: true });
for (const f of ['x402.mjs', 'compare.mjs', 'assets.json']) cpSync(join(root, 'src', f), join(out, 'lib', f));
const jw = dirname(createRequire(import.meta.url).resolve('justweight/core'));
cpSync(join(jw, 'core.mjs'), join(out, 'lib', 'justweight-core.mjs'));
cpSync(join(root, 'test/fixtures/spec'), join(out, 'examples'), { recursive: true });
console.log(`built ${out}`);
