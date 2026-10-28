#!/usr/bin/env node
/**
 * Extract one tenant from a nightly backup database (docs/09 §3.4) into the
 * same `bikri-export` v2 zip as the console and the owner's server export.
 *
 *   node tools/backup/tenant-extract.mjs --db bikri-restore --tenant <id> --out export.zip
 *
 * Use --local when the scratch DB is the local `wrangler dev` one.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPORT_TABLES } from './tables.mjs';
import { zipStore } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PAGE = 500;
const APP_VERSION = process.env.APP_VERSION ?? '0.1.0';
const HIDDEN = { devices: ['token_hash'] };

const MONEY_FIELDS = new Set([
  'amount',
  'avg_cost',
  'bill_discount',
  'bill_discount_alloc',
  'bill_discount_value',
  'cash_expenses',
  'cash_refunds',
  'cash_sales',
  'cash_tendered',
  'change_given',
  'charges_alloc',
  'counted_cash',
  'credit_limit',
  'default_credit_limit',
  'difference',
  'discount',
  'discount_value',
  'exact_amount',
  'expected_cash',
  'gross',
  'gross_total',
  'item_discount_total',
  'landed_unit_cost',
  'last_cost',
  'line_total',
  'net',
  'opening_cash',
  'other_charges',
  'paid_now',
  'paid_total',
  'pay_ins',
  'pay_outs',
  'price',
  'refund_received',
  'round_total_to',
  'rounding',
  'rounding_alloc',
  'subtotal',
  'supplier_cash_in',
  'supplier_cash_out',
  'tax',
  'tax_alloc',
  'total',
  'udhaar_amount',
  'udhaar_cash_in',
  'udhaar_part',
  'unit_cost',
  'unit_cost_snapshot',
  'unit_credit',
  'unit_price',
  'cost_snapshot',
]);
const TIME_FIELDS = new Set([
  'created_at',
  'deleted_at',
  'enrolled_at',
  'expires_at',
  'last_seen_at',
  'period_end',
  'period_start',
  'read_only_seen_at',
  'oldest_pending_at',
  'revoked_at',
  'setup_completed_at',
  'updated_at',
  'at',
]);

/** The backup's restore point: the nightly dump starts at 02:30 Asia/Karachi. */
export function backupExportedAt(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
    throw new Error('--backup-date must be YYYY-MM-DD');
  const at = Date.parse(`${date}T02:30:00+05:00`);
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
  for (const field of HIDDEN[table] ?? []) delete copy[field];
  return copy;
}

function localIso(at) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+05:00`;
}

function csvValue(field, value, row) {
  if (value === null || value === undefined) return '';
  if (TIME_FIELDS.has(field) && typeof value === 'number')
    return localIso(value);
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

export function tableCsv(rows) {
  if (rows.length === 0) return '\uFEFF';
  const fields = [];
  for (const row of rows)
    for (const field of Object.keys(row))
      if (!fields.includes(field)) fields.push(field);
  const lines = [fields.map(csvCell).join(',')];
  for (const row of rows)
    lines.push(
      fields
        .map((field) => csvCell(csvValue(field, row[field], row)))
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
      data: encoder.encode(tableCsv(rowsPage)),
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
