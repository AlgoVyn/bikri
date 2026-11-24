#!/usr/bin/env node
// Bundle budget (docs/08-ux-guidelines.md §7): initial JS (gzip) < 290 KB, every other JS chunk < 100 KB.
// CSS and the offline precache have separate budgets so a regression cannot hide outside the JS graph.
// Run after `pnpm build`. Node 24, no dependencies.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BASE_PATH } from '../packages/core/src/paths.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'apps/pos/dist', BASE_PATH.replace(/^\//u, ''));
const BASE_RE = BASE_PATH.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// 290 KB after counting the (now inline) theme bootstrap and the real initial graph.
const INITIAL_BUDGET = 290 * 1024;
// Leave enough room for the next feature; the hard gate is 290 KB.
const WARN_INITIAL_BUDGET = 285 * 1024;
const CHUNK_BUDGET = 100 * 1024;
const CSS_BUDGET = 25 * 1024;
const PRECACHE_BUDGET = 1.25 * 1024 * 1024;
// Chunk fragmentation gate (D-272): the review target is <=60 chunks and <=8-10
// initial requests. Keep a little headroom for a new route or vendor split.
const MAX_TOTAL_JS_CHUNKS = 60;
const MAX_INITIAL_JS_FILES = 12;
const MAX_MODULE_PRELOADS = 8;
const MAX_SUB_KB_CHUNKS = 10;

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
const preloads = [...html.matchAll(/<link\b[^>]*rel="modulepreload"/gu)].length;
const smallChunks = files.filter((rel) => {
  try {
    return statSync(join(DIST, rel)).size < 1024;
  } catch {
    return false;
  }
}).length;
if (initial.size > MAX_INITIAL_JS_FILES) {
  problems.push(
    `${initial.size} initial JS files (budget ${MAX_INITIAL_JS_FILES})`,
  );
}
if (files.length > MAX_TOTAL_JS_CHUNKS) {
  problems.push(`${files.length} JS chunks (budget ${MAX_TOTAL_JS_CHUNKS})`);
}
if (preloads > MAX_MODULE_PRELOADS) {
  problems.push(
    `${preloads} modulepreload tags (budget ${MAX_MODULE_PRELOADS})`,
  );
}
if (smallChunks > MAX_SUB_KB_CHUNKS) {
  problems.push(
    `${smallChunks} JS chunks under 1 KB (budget ${MAX_SUB_KB_CHUNKS})`,
  );
}
if (initial.size === 0)
  problems.push(
    'no initial scripts found in index.html (output format changed?)',
  );
if (css.length === 0)
  problems.push(
    'no initial stylesheet found in index.html (output format changed?)',
  );
// Count every external module script in index.html.
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
// The active language's catalog is loaded before the first render (D-100): count the
// largest. The build's locale-preload script carries the exact hash map, so main/office/
// public locale chunks are not mistaken for the catalog.
const preloadRel = files.find((rel) =>
  /^assets\/locale-preload-[\w-]+\.js$/.test(rel),
);
let localeMap = {};
if (preloadRel === undefined) {
  problems.push('no locale-preload script found (language preload missing)');
} else {
  const source = readFileSync(join(DIST, preloadRel), 'utf8');
  const match = /var m=(\{[^}]*\})/u.exec(source);
  if (match?.[1]) localeMap = JSON.parse(match[1]);
}
const localeChunks = [];
for (const locale of ['en', 'roman-ur', 'ur']) {
  const rel = localeMap[locale];
  if (typeof rel !== 'string' || !files.includes(rel)) {
    problems.push(`no ${locale} language catalog chunk in the preload map`);
    continue;
  }
  localeChunks.push(rel);
}
const largestLocale = localeChunks.reduce(
  (best, rel) => (best === null || gz(rel) > gz(best) ? rel : best),
  null,
);
if (largestLocale !== null && !initial.has(largestLocale))
  initialTotal += gz(largestLocale);
if (initialTotal > INITIAL_BUDGET) {
  problems.push(
    `initial JS is ${kb(initialTotal)} gz (budget ${kb(INITIAL_BUDGET)})`,
  );
} else if (initialTotal > WARN_INITIAL_BUDGET) {
  console.warn(
    `bundle warning: initial JS is ${kb(initialTotal)} gz; only ${kb(
      INITIAL_BUDGET - initialTotal,
    )} of headroom remains before the ${kb(INITIAL_BUDGET)} gate`,
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
// Workbox appends ?__WB_REVISION__=… when an entry keeps a `revision`. Hashed
// /assets/* files must not: the clean URL was already fetched to render the page,
// and the query-string miss downloads the whole initial graph a second time.
const precacheEntries = [
  ...sw.matchAll(/\{url:"([^"]+)"(?:,revision:(?:"([^"]*)"|null))?\}/gu),
].map((match) => ({
  rel: String(match[1]).replace(`${BASE_PATH}/`, ''),
  revision: match[2] ?? null,
}));
const precache = precacheEntries.map((entry) => entry.rel);
if (precache.length === 0)
  problems.push('no offline precache entries found (Workbox format changed?)');
const revisioned = precacheEntries.filter(
  (entry) =>
    entry.revision !== null &&
    /^assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/u.test(entry.rel),
);
if (revisioned.length > 0) {
  problems.push(
    `${revisioned.length} hashed asset(s) carry a Workbox revision (double download; add dontCacheBustURLsMatching): ${revisioned
      .slice(0, 5)
      .map((entry) => entry.rel)
      .join(', ')}`,
  );
}
// Offline graph integrity (D-299): a precached chunk must never statically import a
// chunk that is not precached. The service worker would replay the importer from
// Cache Storage and the browser would have to fetch the missing dependency from the
// network, so one online-only (`assets/public/`) or operator-console chunk in that
// position takes down every route that shares the importer whenever the fetch fails.
// Lazy (dynamic) imports are allowed: those only run when their route is opened.
const precached = new Set(precache);
const staticImportPattern = /\bfrom"([^"]+\.js)"|\bimport"([^"]+\.js)"/gu;
const danglingImports = [];
for (const rel of precache) {
  if (!rel.endsWith('.js') || !files.includes(rel)) continue;
  const source = readFileSync(join(DIST, rel), 'utf8');
  for (const match of source.matchAll(staticImportPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined || !specifier.startsWith('.')) continue;
    const target = posix.normalize(posix.join(posix.dirname(rel), specifier));
    if (!precached.has(target)) danglingImports.push(`${rel} -> ${target}`);
  }
}
if (danglingImports.length > 0) {
  problems.push(
    `${danglingImports.length} precached chunk(s) statically import a chunk that is not precached (the offline app would fail to load them): ${danglingImports
      .slice(0, 5)
      .join(', ')}`,
  );
}
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
  `initial JS: ${kb(initialTotal)} gz across ${initial.size} file(s) + the largest language catalog (${largestLocale ? kb(gz(largestLocale)) : '0.0 KB'}); ${files.length} JS file(s) total (${smallChunks} under 1 KB); ${preloads} modulepreload tag(s)`,
);
console.log(
  `initial CSS: ${kb(cssTotal)} gz; offline precache: ${kb(precacheTotal)} gz across ${precache.length} entries`,
);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('bundle size: pass');
