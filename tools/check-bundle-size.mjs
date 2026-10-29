#!/usr/bin/env node
// Bundle budget (docs/08-ux-guidelines.md §7): initial JS (gzip) < 258 KB, every other JS chunk < 100 KB.
// Run after `pnpm build`. Node 24, no dependencies.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'apps/pos/dist/bikri');
const INITIAL_BUDGET = 258 * 1024;
const CHUNK_BUDGET = 100 * 1024;

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const initial = new Set(
  [
    ...html.matchAll(
      /<(?:script|link)\b[^>]*(?:src|href)="\/bikri\/([^"]+\.js)"/g,
    ),
  ].map((m) => m[1] ?? ''),
);
const gz = (rel) => gzipSync(readFileSync(join(DIST, rel))).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const jsFiles = readdirSync(join(DIST, 'assets'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `assets/${f}`);
let initialTotal = 0;
const problems = [];
for (const rel of jsFiles) {
  const size = gz(rel);
  if (initial.has(rel)) {
    initialTotal += size;
  } else if (size > CHUNK_BUDGET) {
    problems.push(
      `route chunk ${rel} is ${kb(size)} gz (budget ${kb(CHUNK_BUDGET)})`,
    );
  }
}
// The active language's catalog is loaded before the first render (D-100): count the largest.
const locale = Math.max(
  0,
  ...jsFiles
    .filter((rel) => /^assets\/(en|ur|roman-ur)-[\w-]+\.js$/.test(rel))
    .map(gz),
);
initialTotal += locale;
if (initialTotal > INITIAL_BUDGET) {
  problems.push(
    `initial JS is ${kb(initialTotal)} gz (budget ${kb(INITIAL_BUDGET)})`,
  );
}
console.log(
  `initial JS: ${kb(initialTotal)} gz across ${initial.size} file(s) + the largest language catalog (${kb(locale)}); ${jsFiles.length} JS file(s) total`,
);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('bundle size: pass');
