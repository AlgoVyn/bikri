#!/usr/bin/env node
/**
 * Refuse remote-applied D1 migrations that drop or rename tables/columns.
 * Additive migrations (CREATE TABLE/INDEX, ADD COLUMN) keep the previous Worker
 * serving if `wrangler deploy` fails after `migrations apply`.
 *
 * `DROP INDEX` is allowed (rebuilds). A reviewed exception starts with:
 *   -- bikri:allow-destructive
 *
 * SQLite accepts `ALTER TABLE t DROP col` and `ALTER TABLE t RENAME old TO new`
 * without the optional `COLUMN` keyword, so both forms are checked. Comments are
 * removed only outside quoted strings: a `--` inside a SQL literal is data, not a
 * comment.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/db/migrations',
);

const banned = [
  { re: /\bDROP\s+TABLE\b/i, label: 'DROP TABLE' },
  { re: /\bDROP\s+VIEW\b/i, label: 'DROP VIEW' },
  {
    // `DROP COLUMN` and the optional-keyword form `DROP col`; never `DROP INDEX`.
    re: /\bALTER\s+TABLE\b[^;]{0,200}?\bDROP\s+(?:COLUMN\s+)?(?!INDEX\b|TABLE\b|VIEW\b|TRIGGER\b)[A-Za-z_"`[]/i,
    label: 'DROP COLUMN',
  },
  {
    // `RENAME TO`, `RENAME COLUMN old TO new` and `RENAME old TO new`.
    re: /\bALTER\s+TABLE\b[^;]{0,200}?\bRENAME\s+(?:(?:COLUMN|TO)\b|[^\s;]+\s+TO\b)/i,
    label: 'RENAME TABLE/COLUMN',
  },
];

/** Words that make an identifier followed by `(` a table/index definition, not a call. */
const NOT_A_FUNCTION = new Set([
  'TABLE',
  'EXISTS',
  'INTO',
  'FROM',
  'JOIN',
  'UPDATE',
  'VIEW',
  'INDEX',
  'TRIGGER',
  'CHECK',
  'KEY',
  'UNIQUE',
  'REFERENCES',
  'AS',
  'ON',
  'VALUES',
]);

/** Mask quoted text so a `(` or function-like word inside a literal is ignored. */
function maskQuoted(sql) {
  let out = '';
  let quote = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote !== '') {
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += 'xx';
          i += 1;
        } else {
          out += ch;
          quote = '';
        }
      } else {
        out += 'x';
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) {
        out += 'x'.repeat(sql.length - i);
        break;
      }
      out += `x${'x'.repeat(end - i - 1)}]`;
      i = end;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Count top-level arguments of the call whose `(` is at `open`.
 * @param {string} sql
 * @param {number} open
 * @returns {number | null}
 */
function countArguments(sql, open) {
  let depth = 0;
  let commas = 0;
  let content = false;
  for (let i = open; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') {
      depth += 1;
      if (depth === 1) continue;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return content ? commas + 1 : 0;
    } else if (depth === 1) {
      if (ch === ',') commas += 1;
      else if (!/\s/u.test(ch)) content = true;
    }
  }
  return null;
}

/**
 * Find SQL function calls with more than D1's 32-argument limit (D-103).
 * @param {string} sql
 * @returns {{ name: string, args: number }[]}
 */
export function functionArityFindings(sql) {
  const cleaned = stripComments(sql);
  const masked = maskQuoted(cleaned);
  const findings = [];
  for (const match of masked.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu)) {
    const name = match[1] ?? '';
    const at = match.index ?? 0;
    const before = masked.slice(0, at).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/u);
    if (before?.[1] && NOT_A_FUNCTION.has(before[1].toUpperCase())) continue;
    const open = at + match[0].lastIndexOf('(');
    const args = countArguments(cleaned, open);
    if (args !== null && args > 32) findings.push({ name, args });
  }
  return findings;
}

/**
 * Remove `--` and block comments without touching quoted SQL literals or identifiers.
 * @param {string} sql
 * @returns {string}
 */
export function stripComments(sql) {
  let out = '';
  let quote = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote !== '') {
      out += ch;
      if (ch === quote) {
        if (next === quote) {
          out += next;
          i += 1;
        } else {
          quote = '';
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * @param {string} sql
 * @returns {string[]} destructive statements found in one migration
 */
export function destructiveFindings(sql) {
  if (/^--\s*bikri:allow-destructive\b/m.test(sql)) return [];
  // Mask literals and quoted identifiers: `'DROP TABLE'` in a seed value or comment-like
  // text is data, not DDL (OPS-L3).
  const cleaned = maskQuoted(stripComments(sql));
  return banned
    .filter((rule) => rule.re.test(cleaned))
    .map((rule) => rule.label);
}

/**
 * @param {string} dir
 * @returns {{ file: string, labels: string[] }[]}
 */
export function checkMigrations(dir = DIR) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return files.flatMap((file) => {
    const labels = destructiveFindings(readFileSync(join(dir, file), 'utf8'));
    return labels.length > 0 ? [{ file, labels }] : [];
  });
}

export function main(dir = DIR) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql'));
  const problems = checkMigrations(dir);
  if (problems.length > 0) {
    console.error('Destructive D1 migrations are blocked (docs/09 §3.1.1):');
    for (const { file, labels } of problems)
      for (const label of labels) console.error(`  - ${file}: ${label}`);
    console.error(
      'Rewrite as an additive migration, or add `-- bikri:allow-destructive` after review.',
    );
    process.exitCode = 1;
    return;
  }
  const arity = files.flatMap((file) =>
    functionArityFindings(readFileSync(join(dir, file), 'utf8')).map(
      ({ name, args }) => `${file}: ${name} has ${args} arguments (max 32)`,
    ),
  );
  if (arity.length > 0) {
    console.error('D1 functions may take at most 32 arguments (D-103):');
    for (const problem of arity) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Checked ${files.length} migration files: no destructive DDL, no >32-argument function.`,
  );
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) main();
