#!/usr/bin/env node
// Bundle budget (docs/08-ux-guidelines.md §7): initial JS (gzip) < 290 KB, every other JS chunk < 100 KB.
// CSS and the offline precache have separate budgets so a regression cannot hide outside the JS graph.
// Run after `pnpm build`. Node 24, no dependencies.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BASE_PATH } from '../packages/core/src/paths.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'apps/pos/dist', BASE_PATH.replace(/^\//u, ''));
const BASE_RE = BASE_PATH.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// 290 KB after counting the blocking theme-init.js and recalculating the real initial graph.
const INITIAL_BUDGET = 290 * 1024;
const CHUNK_BUDGET = 100 * 1024;
const CSS_BUDGET = 25 * 1024;
const PRECACHE_BUDGET = 1.25 * 1024 * 1024;

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const initial = new Set(
  [
    ...html.matchAll(
      new RegExp(
        `<(?:script|link)\\b[^>]*(?:src|href)="${BASE_RE}/([^"]+\\.js)"`,
        'g',
      ),
    ),
  ].map((m) => m[1] ?? ''),
);
const css = [
  ...html.matchAll(
    new RegExp(`<link\\b[^>]*href="${BASE_RE}/([^"]+\\.css)"`, 'g'),
  ),
].map((m) => m[1] ?? '');
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
if (initial.size === 0)
  problems.push(
    'no initial scripts found in index.html (output format changed?)',
  );
if (css.length === 0)
  problems.push(
    'no initial stylesheet found in index.html (output format changed?)',
  );
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
for (const locale of ['en', 'roman-ur', 'ur'])
  if (!locales.some((rel) => rel.startsWith(`assets/${locale}-`)))
    problems.push(`no ${locale} language catalog chunk found`);
if (largestLocale !== null && !initial.has(largestLocale))
  initialTotal += gz(largestLocale);
if (initialTotal > INITIAL_BUDGET) {
  problems.push(
    `initial JS is ${kb(initialTotal)} gz (budget ${kb(INITIAL_BUDGET)})`,
  );
}
let cssTotal = 0;
for (const rel of css) cssTotal += gz(rel);
if (cssTotal > CSS_BUDGET) {
  problems.push(`initial CSS is ${kb(cssTotal)} gz (budget ${kb(CSS_BUDGET)})`);
}
// The service worker installs the offline copy; a regression here is felt on
// every first visit and every deploy, not only on a slow route.
const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
const precache = [...sw.matchAll(/\{url:"([^"]+)"/g)].map((m) =>
  String(m[1]).replace(`${BASE_PATH}/`, ''),
);
if (precache.length === 0)
  problems.push('no offline precache entries found (Workbox format changed?)');
let precacheTotal = 0;
for (const rel of precache) {
  try {
    precacheTotal += gz(rel);
  } catch {
    // A URL the build did not emit (a manual cache entry) is not counted.
  }
}
if (precacheTotal > PRECACHE_BUDGET) {
  problems.push(
    `offline precache is ${kb(precacheTotal)} gz (budget ${kb(PRECACHE_BUDGET)})`,
  );
}
console.log(
  `initial JS: ${kb(initialTotal)} gz across ${initial.size} file(s) + the largest language catalog (${largestLocale ? kb(gz(largestLocale)) : '0.0 KB'}); ${files.length} JS file(s) total`,
);
console.log(
  `initial CSS: ${kb(cssTotal)} gz; offline precache: ${kb(precacheTotal)} gz across ${precache.length} entries`,
);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('bundle size: pass');
