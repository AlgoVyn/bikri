#!/usr/bin/env node
/**
 * Extract one tenant from a nightly backup database (docs/09 §3.4) into the
 * same `bikri-export` v2 zip as the console and the owner's server export.
 *
 *   node tools/backup/tenant-extract.mjs --db bikri-restore --tenant <id> --backup-date YYYY-MM-DD --out export.zip
 *
 * Use --local when the scratch DB is the local `wrangler dev` one.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TIME_ZONE,
  isTimeZone,
} from '../../packages/core/src/dates.ts';
import {
  EXPORT_HIDDEN_COLUMNS,
  MONEY_FIELDS,
  TIME_FIELDS,
} from '../../packages/core/src/exportFields.ts';
import { APP_VERSION as CORE_APP_VERSION } from '../../packages/core/src/version.ts';
import { EXPORT_TABLES } from './tables.mjs';
import { zipStore } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PAGE = 500;
export const APP_VERSION = process.env.APP_VERSION ?? CORE_APP_VERSION;

/** The backup's restore point: the nightly dump starts at 05:05 Asia/Karachi. */
export function backupExportedAt(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
    throw new Error('--backup-date must be YYYY-MM-DD');
  const at = Date.parse(`${date}T05:05:00+05:00`);
  const actual = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
  if (!Number.isFinite(at) || actual !== date)
    throw new Error('--backup-date is not a real date');
  return at;
}

export function stripRow(table, row) {
  const copy = { ...row };
  delete copy.tenant_id;
  for (const field of EXPORT_HIDDEN_COLUMNS[table] ?? []) delete copy[field];
  return copy;
}

function zoneOffset(at, timeZone) {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(at))
    .find((entry) => entry.type === 'timeZoneName')?.value;
  return /^GMT([+-]\d{2}:\d{2})$/u.exec(part ?? '')?.[1] ?? '+00:00';
}

function localIso(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${zoneOffset(at, timeZone)}`;
}

function csvValue(field, value, row, timeZone) {
  if (value === null || value === undefined) return '';
  if (TIME_FIELDS.has(field) && typeof value === 'number')
    return localIso(value, timeZone);
  if (
    typeof value === 'number' &&
    ((field === 'discount_value' && row.discount_type === 'pct') ||
      (field === 'bill_discount_value' && row.bill_discount_type === 'pct'))
  )
    return (value / 100).toFixed(2);
  if (MONEY_FIELDS.has(field) && typeof value === 'number')
    return (value / 100).toFixed(2);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function csvCell(value) {
  let text = String(value ?? '');
  if (
    typeof value === 'string' &&
    /^[=+\-@\t\r]/u.test(text) &&
    !/^-?\d+(?:\.\d+)?$/u.test(text)
  )
    text = `'${text}`;
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function tableCsv(rows, timeZone = DEFAULT_TIME_ZONE) {
  const zone = isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  if (rows.length === 0) return '\uFEFF';
  const fields = [];
  for (const row of rows)
    for (const field of Object.keys(row))
      if (!fields.includes(field)) fields.push(field);
  const lines = [fields.map(csvCell).join(',')];
  for (const row of rows)
    lines.push(
      fields
        .map((field) => csvCell(csvValue(field, row[field], row, zone)))
        .join(','),
    );
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--local') out.local = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`missing value for --${key}`);
      out[key] = value;
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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

function rows(stdout) {
  const text = String(stdout).trim();
  const start = text.indexOf('[');
  if (start < 0) throw new Error('wrangler did not return JSON');
  const parsed = JSON.parse(text.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!first || !Array.isArray(first.results))
    throw new Error('wrangler JSON has no result rows');
  return first.results;
}

function query({ db, local, sql }) {
  return rows(
    wrangler([
      'd1',
      'execute',
      db,
      local ? '--local' : '--remote',
      '--json',
      '--command',
      sql,
    ]),
  );
}

async function pageTable({ db, local, tenantId, table }) {
  const out = [];
  let after = '';
  for (let guard = 0; guard < 1_000_000; guard += 1) {
    const where = [`tenant_id = ${sqlString(tenantId)}`];
    if (after) where.push(`id > ${sqlString(after)}`);
    const rowsPage = query({
      db,
      local,
      sql: `SELECT * FROM "${table}" WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${PAGE}`,
    }).map((row) => stripRow(table, row));
    out.push(...rowsPage);
    if (rowsPage.length < PAGE) break;
    after = String(rowsPage.at(-1)?.id ?? '');
    if (!after) break;
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const db = args.db ?? 'bikri-restore';
  const tenantId = args.tenant;
  const outPath = args.out;
  const backupDate = args['backup-date'];
  if (!tenantId || !outPath) throw new Error('--tenant and --out are required');
  if (!backupDate) throw new Error('--backup-date YYYY-MM-DD is required');
  const exportedAt = backupExportedAt(backupDate);
  const local = args.local === true;
  const [tenant] = query({
    db,
    local,
    sql: `SELECT id, slug, display_name FROM tenants WHERE id = ${sqlString(tenantId)}`,
  });
  if (!tenant) throw new Error(`tenant ${tenantId} not found in ${db}`);
  const [shop] = query({
    db,
    local,
    sql: `SELECT timezone FROM shop WHERE tenant_id = ${sqlString(tenantId)}`,
  });
  const storedTimeZone =
    typeof shop?.timezone === 'string' ? shop.timezone : '';
  const timeZone = isTimeZone(storedTimeZone)
    ? storedTimeZone
    : DEFAULT_TIME_ZONE;

  const encoder = new TextEncoder();
  const files = [];
  const counts = {};
  for (const table of EXPORT_TABLES) {
    const rowsPage = await pageTable({ db, local, tenantId, table });
    counts[table] = rowsPage.length;
    files.push({
      name: `json/${table}.json`,
      data: encoder.encode(JSON.stringify(rowsPage)),
    });
    files.push({
      name: `csv/${table}.csv`,
      data: encoder.encode(tableCsv(rowsPage, timeZone)),
    });
  }
  const now = Date.now();
  const manifest = {
    format: 'bikri-export',
    version: 2,
    exported_at: exportedAt,
    app_version: APP_VERSION,
    tenant: {
      id: String(tenant.id),
      display_name: String(tenant.display_name),
    },
    tables: counts,
    source: 'server',
  };
  files.unshift({
    name: 'manifest.json',
    data: encoder.encode(JSON.stringify(manifest, null, 2)),
  });
  writeFileSync(outPath, zipStore(files, now));
  console.log(
    JSON.stringify({ out: outPath, tenant: tenant.id, tables: counts }),
  );
  return manifest;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
