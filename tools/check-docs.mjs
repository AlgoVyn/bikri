#!/usr/bin/env node
// CI docs check (docs/10-testing.md §7):
//  1. every relative link and image in AGENTS.md, README.md and docs/**/*.md resolves to a file
//     (links into docs/reference/dukaan/ are skipped: that folder is local-only and gitignored, D-027);
//  2. packages/db/migrations/0001_init.sql and 0002_seed.sql still match the SQL blocks in
//     docs/02-data-model.md §2 / §2.1 (the doc is the schema source of truth, D-045).
// Node 24, no dependencies. Exit code 1 on any problem.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_ONLY = [join(ROOT, 'docs/reference/dukaan')];

/** @param {string} dir @returns {string[]} */
function mdFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (LOCAL_ONLY.some((l) => p.startsWith(l))) return [];
    if (statSync(p).isDirectory()) return mdFiles(p);
    return p.endsWith('.md') ? [p] : [];
  });
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
];
for (const file of files) {
  for (const link of extractLinks(readFileSync(file, 'utf8'))) {
    if (/^(?:[a-z]+:|#)/i.test(link)) continue; // external, mailto, in-page anchor
    const target = resolve(dirname(file), decodeURI(link.split('#')[0] ?? ''));
    if (LOCAL_ONLY.some((l) => target.startsWith(l))) continue;
    if (!existsSync(target))
      problems.push(`${relative(ROOT, file)}: broken link ${link}`);
  }
}

const doc = readFileSync(join(ROOT, 'docs/02-data-model.md'), 'utf8');
const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map(
  (m) => m[1] ?? '',
);
const migrations = [
  ['0001_init.sql', blocks[0]],
  ['0002_seed.sql', blocks[1]],
];
for (const [name, block] of migrations) {
  const sql = readFileSync(join(ROOT, 'packages/db/migrations', name), 'utf8');
  if (block === undefined || !sql.endsWith(block)) {
    problems.push(
      `packages/db/migrations/${name} differs from its SQL block in docs/02-data-model.md`,
    );
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`docs check: FAIL (${problems.length})`);
  process.exit(1);
}
console.log(
  `docs check: pass (${files.length} markdown files, ${migrations.length} migrations in sync)`,
);
