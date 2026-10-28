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
import { BACKUP_TABLES } from './tables.mjs';

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
  if (!/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?sales\b/iu.test(sql))
    throw new Error('D1 export does not contain CREATE TABLE sales');
}

/** D1 limits compound SELECT terms, so counts go in small batches. */
export function countQueries(tables = BACKUP_TABLES, chunkSize = 5) {
  const out = [];
  for (let i = 0; i < tables.length; i += chunkSize) {
    out.push(
      tables
        .slice(i, i + chunkSize)
        .map(
          (table) =>
            `SELECT '${table}' AS tbl, tenant_id, COUNT(*) AS n FROM "${table}" GROUP BY tenant_id`,
        )
        .join(' UNION ALL '),
    );
  }
  return out;
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
  assertSqlDump(sql.toString('utf8'));
  const size = statSync(sqlPath).size;

  const tenants = parseWranglerJson(
    wrangler([
      'd1',
      'execute',
      database,
      local ? '--local' : '--remote',
      '--json',
      '--command',
      'SELECT id, slug, status FROM tenants ORDER BY id',
    ]),
  );
  const counts = [];
  for (const sql of countQueries()) {
    counts.push(
      ...parseWranglerJson(
        wrangler([
          'd1',
          'execute',
          database,
          local ? '--local' : '--remote',
          '--json',
          '--command',
          sql,
        ]),
      ),
    );
  }

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
