#!/usr/bin/env node
// Bundle budget (docs/08-ux-guidelines.md §7): initial JS (gzip) < 290 KB, every other JS chunk < 100 KB.
// Run after `pnpm build`. Node 24, no dependencies.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'apps/pos/dist/bikri');
// 290 KB after counting the blocking theme-init.js and recalculating the real initial graph.
const INITIAL_BUDGET = 290 * 1024;
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

/** Every JS under assets, including nested admin chunks. */
function jsFiles(dir = join(DIST, 'assets'), prefix = 'assets') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...jsFiles(join(dir, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const files = jsFiles();
let initialTotal = 0;
const problems = [];
// Count every blocking/preloaded script in index.html, including theme-init.js.
for (const rel of initial) initialTotal += gz(rel);
for (const rel of files) {
  if (initial.has(rel)) continue;
  const size = gz(rel);
  if (size > CHUNK_BUDGET) {
    problems.push(
      `route chunk ${rel} is ${kb(size)} gz (budget ${kb(CHUNK_BUDGET)})`,
    );
  }
}
// The active language's catalog is loaded before the first render (D-100): count the largest.
// It is not in index.html (dynamic import), but guard against counting it twice if that changes.
const locales = files.filter((rel) =>
  /^assets\/(en|ur|roman-ur)-[\w-]+\.js$/.test(rel),
);
const largestLocale = locales.reduce(
  (best, rel) => (best === null || gz(rel) > gz(best) ? rel : best),
  null,
);
if (largestLocale !== null && !initial.has(largestLocale))
  initialTotal += gz(largestLocale);
if (initialTotal > INITIAL_BUDGET) {
  problems.push(
    `initial JS is ${kb(initialTotal)} gz (budget ${kb(INITIAL_BUDGET)})`,
  );
}
console.log(
  `initial JS: ${kb(initialTotal)} gz across ${initial.size} file(s) + the largest language catalog (${largestLocale ? kb(gz(largestLocale)) : '0.0 KB'}); ${files.length} JS file(s) total`,
);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('bundle size: pass');
