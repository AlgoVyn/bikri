#!/usr/bin/env node
/**
 * Refuse remote-applied D1 migrations that drop or rename tables/columns.
 * Additive migrations (CREATE TABLE/INDEX, ADD COLUMN) keep the previous Worker
 * serving if `wrangler deploy` fails after `migrations apply`.
 *
 * `DROP INDEX` is allowed (rebuilds). A reviewed exception starts with:
 *   -- bikri:allow-destructive
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/db/migrations',
);
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const banned = [
  { re: /\bDROP\s+TABLE\b/i, label: 'DROP TABLE' },
  { re: /\bDROP\s+VIEW\b/i, label: 'DROP VIEW' },
  {
    re: /\bALTER\s+TABLE\b[\s\S]{0,200}?\bDROP\s+COLUMN\b/i,
    label: 'DROP COLUMN',
  },
  {
    re: /\bALTER\s+TABLE\b[\s\S]{0,120}?\bRENAME\s+(?:TO|COLUMN)\b/i,
    label: 'RENAME TABLE/COLUMN',
  },
];

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const problems = [];
for (const name of files) {
  const raw = readFileSync(join(dir, name), 'utf8');
  if (/^--\s*bikri:allow-destructive\b/m.test(raw)) continue;
  const sql = stripComments(raw);
  for (const rule of banned) {
    if (rule.re.test(sql)) problems.push(`${name}: ${rule.label}`);
  }
}

if (problems.length > 0) {
  console.error('Destructive D1 migrations are blocked (docs/09 §3.1.1):');
  for (const line of problems) console.error(`  - ${line}`);
  console.error(
    'Rewrite as an additive migration, or add `-- bikri:allow-destructive` after review.',
  );
  process.exit(1);
}

console.log(`Checked ${files.length} migration files: no destructive DDL.`);
