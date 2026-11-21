import {
  APP_VERSION,
  DEFAULT_TIME_ZONE,
  EXPORT_HIDDEN_COLUMNS,
  isTimeZone,
  MONEY_FIELDS,
  SYNC_EXPORT_ORDER,
  TIME_FIELDS,
} from '@bikri/core';
import { type BikriDb, LOCAL_ONLY_TABLES } from '@bikri/db';
import { TABLE_COLUMNS } from '@bikri/db/tables';
import type { Table } from 'dexie';
import { crc32Final, crc32Update, ZipStoreWriter } from '../admin/zip.ts';
import { csvCell } from '../lib/csv.ts';
import { tenantInfo } from './localTenant.ts';

const localOnly = new Set<string>(LOCAL_ONLY_TABLES);
/** Rows per primary-key page. One page of sale lines is a few MB, not the whole table. */
const EXPORT_PAGE = 5_000;

/** Export in dependency order so a restore can import table by table without FK failures. */
export const SHOP_EXPORT_TABLES = SYNC_EXPORT_ORDER.filter(
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
  /** Blob parts are appended per table; no full-archive Uint8Array copy is made. */
  blob: Blob;
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

/**
 * `Intl.DateTimeFormat` construction is expensive; the export formats every timestamp
 * cell, so the two formatters are cached per shop time zone instead of per cell.
 */
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const offsetFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(timeZone: string): Intl.DateTimeFormat {
  let format = dateFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dateFormats.set(timeZone, format);
  }
  return format;
}

function offsetFormat(timeZone: string): Intl.DateTimeFormat {
  let format = offsetFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    });
    offsetFormats.set(timeZone, format);
  }
  return format;
}

/** `+05:00`-style offset for the shop's zone at `at` (DST-safe). */
function zoneOffset(at: number, timeZone: string): string {
  const part = offsetFormat(timeZone)
    .formatToParts(new Date(at))
    .find((entry) => entry.type === 'timeZoneName')?.value;
  const match = /^GMT([+-]\d{2}:\d{2})$/u.exec(part ?? '');
  return match?.[1] ?? '+00:00';
}

function localIso(at: number, timeZone: string): string {
  const parts = dateFormat(timeZone).formatToParts(new Date(at));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${zoneOffset(at, timeZone)}`;
}

function csvValue(
  field: string,
  value: unknown,
  row: Record<string, unknown>,
  timeZone: string,
): string {
  if (value === null || value === undefined) return '';
  if (TIME_FIELDS.has(field) && typeof value === 'number')
    return localIso(value, timeZone);
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

/** Every key of the page, in first-seen order (used by the small `tableCsv` helper). */
function fieldUnion(rows: readonly Record<string, unknown>[]): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const field of Object.keys(row)) {
      if (field === 'tenant_id' || seen.has(field)) continue;
      seen.add(field);
      fields.push(field);
    }
  }
  return fields;
}

/**
 * CSV columns for a table: the D1 columns minus tenant/hidden ones, then any local-only
 * column the first page carries (Dexie V10's `refund_lines.business_date`). Fixing the
 * header up front lets a large table stream page by page.
 */
export function exportCsvColumns(
  table: string,
  firstRows: readonly Record<string, unknown>[],
): string[] {
  const hidden = new Set(EXPORT_HIDDEN_COLUMNS[table] ?? []);
  const known = new Set<string>();
  const fields: string[] = [];
  const columns = (
    TABLE_COLUMNS as Record<string, readonly string[] | undefined>
  )[table];
  for (const column of columns ?? []) {
    if (column === 'tenant_id' || hidden.has(column) || known.has(column))
      continue;
    known.add(column);
    fields.push(column);
  }
  for (const field of fieldUnion(firstRows)) {
    if (hidden.has(field) || known.has(field)) continue;
    known.add(field);
    fields.push(field);
  }
  return fields;
}

export function exportCsvHeader(columns: readonly string[]): string {
  return `\uFEFF${columns.map(csvCell).join(',')}\r\n`;
}

export function exportCsvRows(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  timeZone = DEFAULT_TIME_ZONE,
): string {
  if (rows.length === 0) return '';
  const zone = isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return `${rows
    .map((row) =>
      columns
        .map((field) => csvCell(csvValue(field, row[field], row, zone)))
        .join(','),
    )
    .join('\r\n')}\r\n`;
}

export function tableCsv(
  rows: readonly Record<string, unknown>[],
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const zone = isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  if (rows.length === 0) return '\uFEFF';
  const fields = fieldUnion(rows);
  return `${exportCsvHeader(fields)}${exportCsvRows(rows, fields, zone)}`;
}

/** Text accumulated as per-page Blobs and entered into the zip once. */
export class ExportStream {
  private readonly encoder = new TextEncoder();
  private readonly parts: Blob[] = [];
  private crc = 0xffffffff;
  private bytes = 0;

  get empty(): boolean {
    return this.bytes === 0;
  }

  push(text: string): void {
    if (text === '') return;
    const data = this.encoder.encode(text);
    this.crc = crc32Update(this.crc, data);
    this.bytes += data.length;
    this.parts.push(new Blob([data]));
  }

  addTo(writer: ZipStoreWriter, name: string): void {
    writer.addBlob(
      name,
      new Blob(this.parts),
      crc32Final(this.crc),
      this.bytes,
    );
  }
}

/** JSON array streamed as `[` + page items separated by commas + `]`. */
export class JsonStream {
  private readonly stream = new ExportStream();
  private started = false;

  push(rows: readonly Record<string, unknown>[]): void {
    if (rows.length === 0) return;
    const items = JSON.stringify(rows).slice(1, -1);
    this.stream.push(`${this.started ? ',' : '['}${items}`);
    this.started = true;
  }

  addTo(writer: ZipStoreWriter, name: string): void {
    if (!this.started) this.stream.push('[]');
    else this.stream.push(']');
    this.stream.addTo(writer, name);
  }
}

function exportStamp(now: number, timeZone: string): string {
  return dateFormat(timeZone)
    .format(now)
    .replaceAll(/[^0-9]/gu, '')
    .slice(0, 12);
}

export function shopExportFilename(
  displayName: string,
  now: number,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const zone = isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return `bikri-export-${slugify(displayName)}-${exportStamp(now, zone)}.zip`;
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
  const storedTimeZone = String(shop?.timezone ?? '');
  const timeZone = isTimeZone(storedTimeZone)
    ? storedTimeZone
    : DEFAULT_TIME_ZONE;
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
  const writer = new ZipStoreWriter(now);
  for (const [index, name] of SHOP_EXPORT_TABLES.entries()) {
    const table = db.table(name) as Table<Record<string, unknown>, string>;
    const hidden = new Set(EXPORT_HIDDEN_COLUMNS[name] ?? []);
    const json = new JsonStream();
    const csv = new ExportStream();
    let columns: string[] | null = null;
    let rows = 0;
    let after = '';
    for (;;) {
      // Primary-key pages keep peak memory to one page even for 400k sale lines.
      const page = await table
        .where(':id')
        .above(after)
        .limit(EXPORT_PAGE)
        .toArray();
      if (page.length === 0) break;
      after = String(page.at(-1)?.id ?? '');
      // Point-in-time: a row created after the export started is left out of both the
      // table and its children, so a restore never gets an orphan line.
      const clean: Record<string, unknown>[] = [];
      for (const row of page) {
        if (typeof row.created_at === 'number' && row.created_at > now)
          continue;
        const copy = { ...row };
        delete copy.tenant_id;
        for (const field of hidden) delete copy[field];
        clean.push(copy);
      }
      if (clean.length > 0) {
        rows += clean.length;
        json.push(clean);
        columns ??= exportCsvColumns(name, clean);
        if (csv.empty) csv.push(exportCsvHeader(columns));
        csv.push(exportCsvRows(clean, columns, timeZone));
      }
      if (page.length < EXPORT_PAGE || after === '') break;
    }
    json.addTo(writer, `json/${name}.json`);
    if (csv.empty) csv.push('\uFEFF');
    csv.addTo(writer, `csv/${name}.csv`);
    manifest.tables[name] = rows;
    options.onProgress?.({
      table: name,
      index,
      total: SHOP_EXPORT_TABLES.length,
      rows,
    });
    // Let the event loop breathe between tables; Blob parts hold the bytes.
    if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  writer.add(
    'manifest.json',
    new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  );
  return {
    blob: writer.finish(),
    filename: shopExportFilename(displayName, now, timeZone),
    manifest,
  };
}
