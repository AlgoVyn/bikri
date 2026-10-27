import { APP_VERSION } from '@bikri/core';
import { type BikriDb, DEXIE_SCHEMA_V1, LOCAL_ONLY_TABLES } from '@bikri/db';
import { zipStore } from '../admin/zip.ts';
import { csvCell } from '../lib/csv.ts';
import { tenantInfo } from './localTenant.ts';

/** Money columns in 02 (all paisa) — the full export CSV shows rupees with two decimals. */
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
  'cost_snapshot',
  'charges_alloc',
  'counted_cash',
  'credit_limit',
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
  'refund_received',
]);

const TIME_FIELDS = new Set([
  'created_at',
  'deleted_at',
  'enrolled_at',
  'expires_at',
  'last_seen_at',
  'period_end',
  'period_start',
  'revoked_at',
  'updated_at',
]);

const localOnly = new Set<string>(LOCAL_ONLY_TABLES);

export const SHOP_EXPORT_TABLES = Object.keys(DEXIE_SCHEMA_V1).filter(
  (table) => !localOnly.has(table),
);

export type ShopExportManifest = {
  format: 'bikri-export';
  version: 2;
  exported_at: number;
  app_version: string;
  tenant: { id: string; display_name: string };
  tables: Record<string, number>;
  source?: 'device' | 'server';
  snapshot_seq?: number;
};

export type ShopExportProgress = {
  table: string;
  index: number;
  total: number;
  rows: number;
};

export type ShopExport = {
  bytes: Uint8Array;
  filename: string;
  manifest: ShopExportManifest;
};

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 40) || 'shop'
  );
}

function localIso(at: number): string {
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
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+05:00`;
}

function csvValue(
  field: string,
  value: unknown,
  row: Record<string, unknown>,
): string {
  if (value === null || value === undefined) return '';
  if (TIME_FIELDS.has(field) && typeof value === 'number')
    return localIso(value);
  // Discount values are basis points when the same row says `pct`; showing paisa there
  // would silently divide a percentage by 100.
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

export function tableCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '\uFEFF';
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const field of Object.keys(row)) {
      if (field === 'tenant_id' || seen.has(field)) continue;
      seen.add(field);
      fields.push(field);
    }
  }
  const lines = [fields.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(
      fields
        .map((field) => csvCell(csvValue(field, row[field], row)))
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function exportStamp(now: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(now)
    .replaceAll(/[^0-9]/gu, '')
    .slice(0, 12);
}

export function shopExportFilename(displayName: string, now: number): string {
  return `bikri-export-${slugify(displayName)}-${exportStamp(now)}.zip`;
}

/** All of this shop's synced tables as a `bikri-export` v2 zip (09 §3.3). */
export async function buildShopExport(
  db: BikriDb,
  options: {
    now?: number;
    onProgress?: (progress: ShopExportProgress) => void;
  } = {},
): Promise<ShopExport> {
  const now = options.now ?? Date.now();
  const tenant = await tenantInfo(db);
  const shop = await db.shop.get('shop');
  const displayName =
    tenant?.display_name || String(shop?.name ?? '') || 'Shop';
  const manifest: ShopExportManifest = {
    format: 'bikri-export',
    version: 2,
    exported_at: now,
    app_version: APP_VERSION,
    tenant: {
      id: tenant?.id ?? db.tenantId,
      display_name: displayName,
    },
    tables: {},
  };
  const files: { name: string; data: Uint8Array }[] = [];
  const encoder = new TextEncoder();
  for (const [index, table] of SHOP_EXPORT_TABLES.entries()) {
    const rows = (await db.table(table).toArray()) as Record<string, unknown>[];
    const clean = rows.map((row) => {
      const copy = { ...row };
      delete copy.tenant_id;
      return copy;
    });
    manifest.tables[table] = clean.length;
    options.onProgress?.({
      table,
      index,
      total: SHOP_EXPORT_TABLES.length,
      rows: clean.length,
    });
    files.push({
      name: `json/${table}.json`,
      data: encoder.encode(JSON.stringify(clean)),
    });
    files.push({
      name: `csv/${table}.csv`,
      data: encoder.encode(tableCsv(clean)),
    });
    if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  files.unshift({
    name: 'manifest.json',
    data: encoder.encode(JSON.stringify(manifest, null, 2)),
  });
  return {
    bytes: zipStore(files, now),
    filename: shopExportFilename(displayName, now),
    manifest,
  };
}
