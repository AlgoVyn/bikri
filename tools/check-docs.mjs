#!/usr/bin/env node
// CI docs check (docs/10-testing.md §7):
//  1. every relative link and image in AGENTS.md, README.md and docs/**/*.md resolves to a file
//     (links into docs/reference/dukaan/ are skipped: that folder is local-only and gitignored, D-027);
//  2. every packages/db/migrations/*.sql still matches its SQL block in
//     docs/02-data-model.md §2 (the doc is the schema source of truth, D-045).
// Node 24, no dependencies. Exit code 1 on any problem.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { functionArityFindings } from './check-migrations-safe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_ONLY = [
  join(ROOT, 'docs/reference/dukaan'),
  join(ROOT, 'docs/reviews'),
];

/** @param {string} dir @returns {string[]} */
function mdFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (LOCAL_ONLY.some((l) => p.startsWith(l))) return [];
    if (statSync(p).isDirectory()) return mdFiles(p);
    return p.endsWith('.md') ? [p] : [];
  });
}

/** GitHub heading slug (keeps Unicode letters/numbers, `_` and `-`). @param {string} heading */
export function headingSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/gu, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/gu, '-');
}

/** @param {string} file @returns {Set<string>} */
export function headingAnchors(file) {
  const anchors = new Set();
  let inFence = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(?:#{1,6})\s+(.*)$/u.exec(line);
    if (heading?.[1]) anchors.add(headingSlug(heading[1]));
  }
  return anchors;
}

/** @param {string} md */
export function extractLinks(md) {
  const noCode = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  /** @type {string[]} */
  const out = [];
  for (const m of noCode.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g))
    out.push(m[1] ?? '');
  for (const m of noCode.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g))
    out.push(m[1] ?? '');
  return out;
}

const problems = [];
const files = [
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'README.md'),
  ...mdFiles(join(ROOT, 'docs')),
  ...['apps', 'packages'].flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .map((name) => join(ROOT, dir, name, 'README.md'))
      .filter((file) => existsSync(file)),
  ),
  ...[join(ROOT, 'tools/backup/README.md')].filter((file) => existsSync(file)),
];
for (const file of files) {
  for (const link of extractLinks(readFileSync(file, 'utf8'))) {
    if (/^[a-z]+:/i.test(link)) continue; // external URL, mailto
    const [pathPart = '', anchorPart] = link.split('#');
    const target =
      pathPart === '' ? file : resolve(dirname(file), decodeURI(pathPart));
    if (LOCAL_ONLY.some((l) => target.startsWith(l))) continue;
    if (!existsSync(target)) {
      problems.push(`${relative(ROOT, file)}: broken link ${link}`);
      continue;
    }
    if (!anchorPart || !target.endsWith('.md')) continue;
    let anchor;
    try {
      anchor = decodeURIComponent(anchorPart);
    } catch {
      anchor = anchorPart;
    }
    if (!headingAnchors(target).has(anchor))
      problems.push(`${relative(ROOT, file)}: missing heading anchor ${link}`);
  }
}

const doc = readFileSync(join(ROOT, 'docs/02-data-model.md'), 'utf8');
const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => ({
  at: m.index ?? 0,
  sql: m[1] ?? '',
}));
const migrationDir = join(ROOT, 'packages/db/migrations');
const migrationFiles = readdirSync(migrationDir).filter((name) =>
  /^\d{4}_.+\.sql$/u.test(name),
);
if (migrationFiles.length === 0) problems.push('no migration files found');
for (const name of migrationFiles) {
  // The doc has one SQL block per migration heading (`... (migration \`0001...sql\`)`).
  const block = blocks.find((candidate) => {
    const heading = doc.slice(Math.max(0, candidate.at - 10_000), candidate.at);
    return heading.includes(`migration \`${name}\``);
  });
  const sql = readFileSync(join(migrationDir, name), 'utf8');
  const prefix = block ? sql.slice(0, sql.length - block.sql.length) : '';
  const headerOnly = prefix
    .split('\n')
    .every((line) => line.trim() === '' || line.trim().startsWith('--'));
  if (!block || !sql.endsWith(block.sql) || !headerOnly)
    problems.push(
      `packages/db/migrations/${name} differs from its SQL block in docs/02-data-model.md`,
    );
}
// A SQL block copied into the doc must obey the same D1 32-argument limit (D-103).
for (const block of blocks)
  for (const { name, args } of functionArityFindings(block.sql))
    problems.push(
      `docs/02-data-model.md: ${name} has ${args} arguments (max 32)`,
    );

// The doc is the operational reference; its version, CSP header and section order must
// match the Worker and the till (OPS-L2).
const architecture = readFileSync(
  join(ROOT, 'docs/01-architecture.md'),
  'utf8',
);
const docAppVersion = /"APP_VERSION":\s*"([^"]+)"/u.exec(architecture)?.[1];
const workerAppVersion = /"APP_VERSION":\s*"([^"]+)"/u.exec(
  readFileSync(join(ROOT, 'apps/api/wrangler.jsonc'), 'utf8'),
)?.[1];
if (!docAppVersion || docAppVersion !== workerAppVersion)
  problems.push(
    `docs/01-architecture.md APP_VERSION ${docAppVersion ?? '?'} differs from wrangler.jsonc ${workerAppVersion ?? '?'}`,
  );

const docCsp = /^\s*Content-Security-Policy:\s*(.+)$/mu
  .exec(architecture)?.[1]
  ?.trim();
const coreCsp = /'Content-Security-Policy':\s*"([^"]+)"/u.exec(
  readFileSync(join(ROOT, 'packages/core/src/securityHeaders.ts'), 'utf8'),
)?.[1];
if (!docCsp || docCsp !== coreCsp)
  problems.push(
    'docs/01-architecture.md Content-Security-Policy differs from packages/core/src/securityHeaders.ts',
  );

const dexieAt = doc.indexOf('\n## 3. Dexie schema');
for (const match of doc.matchAll(/^### 2\.\d+\s/gmu))
  if ((match.index ?? 0) > dexieAt)
    problems.push(
      `docs/02-data-model.md: ${match[0].trim()} is under the Dexie section`,
    );

// Reviews keep finding duplicate decision numbers (L10); fail CI the next time.
const decisions = readFileSync(join(ROOT, 'docs/decisions.md'), 'utf8');
const seenDecisions = new Set();
const duplicateDecisions = new Set();
for (const match of decisions.matchAll(/^\| (D-\d+) /gmu)) {
  const id = match[1];
  if (seenDecisions.has(id)) duplicateDecisions.add(id);
  seenDecisions.add(id);
}
if (duplicateDecisions.size > 0)
  problems.push(
    `docs/decisions.md: duplicate decision id(s) ${[...duplicateDecisions].sort().join(', ')}`,
  );

// Keep the Worker and the till on one schema number (review L9); `BUNDLE_SCHEMA` is a
// feature gate and deliberately stays at the version where bundles shipped.
const serverSchema = /"SCHEMA_VERSION":\s*"(\d+)"/u.exec(
  readFileSync(join(ROOT, 'apps/api/wrangler.jsonc'), 'utf8'),
)?.[1];
const clientSchema = /CLIENT_SCHEMA_VERSION\s*=\s*(\d+)/u.exec(
  readFileSync(join(ROOT, 'packages/core/src/version.ts'), 'utf8'),
)?.[1];
if (!serverSchema || !clientSchema || serverSchema !== clientSchema)
  problems.push(
    `schema versions differ: Worker ${serverSchema ?? '?'}, client ${clientSchema ?? '?'}`,
  );

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`docs check: FAIL (${problems.length})`);
  process.exit(1);
}
console.log(
  `docs check: pass (${files.length} markdown files, ${migrationFiles.length} migrations in sync)`,
);
