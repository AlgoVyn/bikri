#!/usr/bin/env node
/**
 * Nightly D1 backup: export the whole database, verify that the dump looks
 * complete, count rows per tenant and write the manifest of docs/09 §2.
 *
 * Usage:
 *   node tools/backup/export.mjs --out-dir .backups [--date YYYY-MM-DD] [--local]
 * Requires `pnpm`, the wrangler config in apps/api and (remote) a Cloudflare token.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_TABLES, PLATFORM_TABLES } from './tables.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** `YYYY-MM-DD` in the shop time zone. */
export function backupDate(now = Date.now(), timeZone = 'Asia/Karachi') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Wrangler prints `[{ results, success, meta }]`; tolerate a warning before it. */
export function parseWranglerJson(stdout) {
  const text = String(stdout).trim();
  const start = text.indexOf('[');
  if (start < 0) throw new Error('wrangler did not return JSON');
  const parsed = JSON.parse(text.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!first || !Array.isArray(first.results))
    throw new Error('wrangler JSON has no result rows');
  return first.results;
}

/** The dump must contain the schema, not just a header (09 §2 step 3). */
export function assertSqlDump(sql) {
  if (Buffer.byteLength(sql, 'utf8') < 1024)
    throw new Error('D1 export is smaller than 1 KB');
  const created = new Set(
    [
      ...sql.matchAll(
        /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?([a-z_][a-z0-9_]*)["`\]]?/giu,
      ),
    ].map((match) => String(match[1]).toLowerCase()),
  );
  const required = ['meta', 'tenants', ...BACKUP_TABLES, ...PLATFORM_TABLES];
  const missing = required.filter((table) => !created.has(table.toLowerCase()));
  if (missing.length > 0)
    throw new Error(
      `D1 export is missing table(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`,
    );
  // A schema-only dump is not a backup. Every real shop database has at least one tenant.
  if (!/INSERT INTO\s+["`[]?tenants\b/iu.test(sql))
    throw new Error('D1 export does not contain tenant data');
}

/**
 * Split a SQL dump into statements without being confused by semicolons inside quoted
 * values. D1 writes one INSERT per row, but values can contain commas, parentheses and
 * newlines, so the count parser cannot work line by line.
 * @param {string} sql
 * @returns {Generator<string>}
 */
function* sqlStatements(sql) {
  let start = 0;
  let quote = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote !== '') {
      if (ch === quote) {
        if (sql[i + 1] === quote) i += 1;
        else quote = '';
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i + 2);
      i = newline === -1 ? sql.length : newline;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === ';') {
      yield sql.slice(start, i + 1);
      start = i + 1;
    }
  }
  if (sql.slice(start).trim() !== '') yield sql.slice(start);
}

/**
 * Split the body of one VALUES tuple on top-level commas, respecting quotes and nested
 * parentheses.
 * @param {string} text
 * @returns {string[]}
 */
function splitSqlValues(text) {
  /** @type {string[]} */
  const out = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === quote) {
        if (text[i + 1] === quote) i += 1;
        else quote = '';
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/**
 * Parse the `(…), (…)` part of an INSERT into one value list per row.
 * @param {string} text
 * @returns {string[][]}
 */
function parseSqlTuples(text) {
  /** @type {string[][]} */
  const rows = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[\s,]/u.test(text[i])) i += 1;
    if (i >= text.length) break;
    if (text[i] !== '(') throw new Error('expected a VALUES tuple');
    let depth = 1;
    let quote = '';
    let j = i + 1;
    for (; j < text.length; j += 1) {
      const ch = text[j];
      if (quote !== '') {
        if (ch === quote) {
          if (text[j + 1] === quote) j += 1;
          else quote = '';
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error('unterminated VALUES tuple');
    rows.push(splitSqlValues(text.slice(i + 1, j)));
    i = j + 1;
  }
  return rows;
}

/** @param {string} value */
function unquoteSql(value) {
  const text = value.trim();
  if (text.startsWith("'") && text.endsWith("'"))
    return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"') && text.endsWith('"'))
    return text.slice(1, -1).replaceAll('""', '"');
  return text;
}

/**
 * Counts tenant rows directly from the export dump. This replaces the second full-table
 * `COUNT(*)` pass over D1; the manifest still has exact per-tenant counts for a restore
 * drill. A backup INSERT for a known tenant table that cannot be parsed is an error, not a
 * silent zero.
 * @param {string} sql
 * @returns {{ tbl: string, tenant_id: string, n: number }[]}
 */
export function countDumpRows(sql) {
  const wanted = new Set(BACKUP_TABLES);
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const statement of sqlStatements(sql)) {
    const text = statement.trim();
    if (!/^INSERT\s+INTO/iu.test(text)) continue;
    const head = /^INSERT\s+INTO\s+["`[]?([A-Za-z0-9_]+)["`\]]?/iu.exec(text);
    const table = head?.[1]?.toLowerCase();
    if (!table || !wanted.has(table)) continue;
    const parsed =
      /^INSERT\s+INTO\s+["`[]?[A-Za-z0-9_]+["`\]]?\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/iu.exec(
        text,
      );
    if (!parsed)
      throw new Error(`backup dump: cannot parse INSERT for ${table}`);
    const columns = parsed[1].split(',').map((column) =>
      column
        .trim()
        .replace(/^["`[]/u, '')
        .replace(/["`\]]$/u, '')
        .toLowerCase(),
    );
    const tenantIndex = columns.indexOf('tenant_id');
    if (tenantIndex < 0)
      throw new Error(`backup dump: ${table} INSERT has no tenant_id column`);
    const rows = parseSqlTuples(parsed[2].replace(/;\s*$/u, ''));
    for (const values of rows) {
      if (values.length !== columns.length)
        throw new Error(
          `backup dump: ${table} row has ${values.length} values for ${columns.length} columns`,
        );
      const tenantId = unquoteSql(values[tenantIndex] ?? '');
      if (!tenantId || tenantId === 'NULL')
        throw new Error(`backup dump: ${table} row has no tenant_id`);
      const key = `${table}\u0000${tenantId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].map(([key, n]) => {
    const [tbl, tenant_id] = key.split('\u0000');
    return { tbl, tenant_id, n };
  });
}

/**
 * Reads the tenant list from the same dump that is hashed and uploaded. A second
 * `SELECT` against live D1 after the export could return a tenant created or edited
 * between the dump and the query, making the manifest describe a different database.
 * @param {string} sql
 * @returns {{ id: string, slug: string, status: string }[]}
 */
export function parseDumpTenants(sql) {
  const tenants = [];
  for (const statement of sqlStatements(sql)) {
    const text = statement.trim();
    const head =
      /^INSERT\s+INTO\s+["`[]?tenants["`\]]?\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/iu.exec(
        text,
      );
    if (!head) {
      if (/^INSERT\s+INTO\s+["`[]?tenants\b/iu.test(text))
        throw new Error('backup dump: unparseable tenants INSERT');
      continue;
    }
    const columns = head[1].split(',').map((column) =>
      column
        .trim()
        .replace(/^["`[]/u, '')
        .replace(/["`\]]$/u, '')
        .toLowerCase(),
    );
    const idIndex = columns.indexOf('id');
    const slugIndex = columns.indexOf('slug');
    const statusIndex = columns.indexOf('status');
    if (idIndex < 0)
      throw new Error('backup dump: tenants INSERT has no id column');
    const rows = parseSqlTuples(head[2].replace(/;\s*$/u, ''));
    for (const values of rows) {
      if (values.length !== columns.length)
        throw new Error(
          `backup dump: tenants row has ${values.length} values for ${columns.length} columns`,
        );
      const id = unquoteSql(values[idIndex] ?? '');
      if (!id) throw new Error('backup dump: tenants row has no id');
      tenants.push({
        id,
        slug: slugIndex < 0 ? '' : unquoteSql(values[slugIndex] ?? ''),
        status: statusIndex < 0 ? '' : unquoteSql(values[statusIndex] ?? ''),
      });
    }
  }
  return tenants;
}

export function buildTenantManifest(tenants, counts) {
  const out = {};
  for (const tenant of tenants) {
    out[String(tenant.id)] = {
      slug: String(tenant.slug ?? ''),
      status: String(tenant.status ?? ''),
      tables: Object.fromEntries(BACKUP_TABLES.map((table) => [table, 0])),
    };
  }
  for (const row of counts) {
    const tenant = out[String(row.tenant_id)];
    const table = String(row.tbl);
    if (tenant && Object.hasOwn(tenant.tables, table))
      tenant.tables[table] = Number(row.n ?? 0);
  }
  return out;
}

export function buildManifest({ date, tenants, counts, sha256 }) {
  return {
    date,
    tenants: buildTenantManifest(tenants, counts),
    sha256,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--local') out.local = true;
    else if (arg === '--remote') out.local = false;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`missing value for --${key}`);
      out[key] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return out;
}

function wrangler(args) {
  const bin = join(ROOT, 'apps/api/node_modules/.bin/wrangler');
  const res = spawnSync(bin, args, {
    cwd: join(ROOT, 'apps/api'),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0)
    throw new Error(
      `wrangler ${args.join(' ')} failed:\n${res.stderr || res.stdout}`,
    );
  return res.stdout;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const database = args.database ?? 'bikri';
  const date = args.date ?? backupDate();
  const local = args.local === true;
  const outDir = resolve(args['out-dir'] ?? join(ROOT, '.backups'));
  mkdirSync(outDir, { recursive: true });
  const sqlPath = join(outDir, `bikri-${date}.sql`);
  const manifestPath = join(outDir, `bikri-${date}.manifest.json`);

  wrangler([
    'd1',
    'export',
    database,
    local ? '--local' : '--remote',
    '--skip-confirmation',
    `--output=${sqlPath}`,
  ]);

  const sql = readFileSync(sqlPath);
  const sqlText = sql.toString('utf8');
  assertSqlDump(sqlText);
  const size = statSync(sqlPath).size;

  const tenants = parseDumpTenants(sqlText);
  if (tenants.length === 0)
    throw new Error('D1 export has no tenant rows in the dump');
  const counts = countDumpRows(sqlText);

  const manifest = buildManifest({
    date,
    tenants,
    counts,
    sha256: sha256(sql),
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    JSON.stringify({
      date,
      sqlPath,
      manifestPath,
      bytes: size,
      tenants: Object.keys(manifest.tenants).length,
    }),
  );
  return manifest;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
