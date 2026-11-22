import {
  APP_VERSION,
  DEFAULT_TIME_ZONE,
  EXPORT_HIDDEN_COLUMNS,
  isTimeZone,
  SYNC_EXPORT_ORDER,
} from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { ZipStoreWriter } from '../admin/zip.ts';
import { SyncHttpError } from '../sync/client.ts';
import { shopRequest } from '../sync/shopApi.ts';
import { tenantInfo } from './localTenant.ts';
import {
  ExportStream,
  exportCsvColumns,
  exportCsvHeader,
  exportCsvRows,
  JsonStream,
  type ShopExportManifest,
  shopExportFilename,
} from './shopExport.ts';

export const SERVER_EXPORT_PAGE = 500;
const SESSION_KEY = 'bikri.server_export';

export type ServerExportTable = { tbl: string; rows: number };

export type ServerExportStart = {
  export_id: string;
  snapshot_seq: number;
  exported_at?: number;
  tables: ServerExportTable[];
};

export type ServerExportPage = {
  tbl: string;
  rows: Record<string, unknown>[];
  next_after: string;
  has_more: boolean;
};

type Session = {
  export_id: string;
  snapshot_seq: number;
  tables: ServerExportTable[];
  /** A server export token is valid for 2 h (04 §3.8). */
  started_at: number;
  exported_at: number;
  tenant_id: string;
};

const EXPORT_TTL = 2 * 60 * 60 * 1000;

function expired(error: unknown): boolean {
  return (
    error instanceof SyncHttpError &&
    error.status === 400 &&
    /expired/iu.test(error.message)
  );
}

function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function writeSession(session: Session | null): void {
  // Private browsing and full quotas make sessionStorage throw; an export resume token
  // is optional, so losing it must never break the export (SYNC-L3).
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* no session storage */
  }
}

export function clearServerExportSession(): void {
  writeSession(null);
}

async function page(
  db: BikriDb,
  staffId: string,
  exportId: string,
  tbl: string,
  after: string,
): Promise<ServerExportPage> {
  const params = new URLSearchParams({
    export_id: exportId,
    tbl,
    after,
    limit: String(SERVER_EXPORT_PAGE),
  });
  return shopRequest<ServerExportPage>(
    db,
    staffId,
    `/export?${params.toString()}`,
  );
}

export type ServerExportProgress = {
  table: string;
  index: number;
  total: number;
  rows: number;
  done: number;
};

/** Pages the server export and builds the same zip as the device export (T-053). */
async function buildOnce(
  db: BikriDb,
  staffId: string,
  options: { onProgress?: (progress: ServerExportProgress) => void },
): Promise<{
  blob: Blob;
  filename: string;
  manifest: ShopExportManifest;
}> {
  let session = readSession();
  const fresh =
    session !== null &&
    session.tenant_id === db.tenantId &&
    Date.now() - session.started_at < EXPORT_TTL;
  if (session && fresh)
    session = {
      ...session,
      exported_at: session.exported_at ?? Date.now(),
    };
  else {
    clearServerExportSession();
    const start = await shopRequest<ServerExportStart>(db, staffId, '/export', {
      method: 'POST',
    });
    session = {
      export_id: start.export_id,
      snapshot_seq: start.snapshot_seq,
      exported_at: start.exported_at ?? Date.now(),
      tables: start.tables,
      started_at: Date.now(),
      tenant_id: db.tenantId,
    };
    writeSession(session);
  }
  const rank = new Map<string, number>(
    SYNC_EXPORT_ORDER.map((tbl, index) => [tbl, index]),
  );
  const tables = [...session.tables].sort(
    (left, right) =>
      (rank.get(left.tbl) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.tbl) ?? Number.MAX_SAFE_INTEGER),
  );
  const shop = await db.shop.get('shop');
  const storedTimeZone = String(shop?.timezone ?? '');
  const timeZone = isTimeZone(storedTimeZone)
    ? storedTimeZone
    : DEFAULT_TIME_ZONE;
  const writer = new ZipStoreWriter(session.exported_at);
  const encoder = new TextEncoder();
  const counts: { tbl: string; rows: number }[] = [];
  // A retry always starts every table from row zero. Persisting only a cursor/“done” flag
  // would make the resumed zip miss the rows fetched before the failure; re-reading with the
  // same export token is cheap enough and keeps the archive complete.
  for (const [index, table] of tables.entries()) {
    const hidden = new Set(EXPORT_HIDDEN_COLUMNS[table.tbl] ?? []);
    const json = new JsonStream();
    const csv = new ExportStream();
    let columns: string[] | null = null;
    let rows = 0;
    let after = '';
    for (let guard = 0; guard < 100_000; guard += 1) {
      const result = await page(
        db,
        staffId,
        session.export_id,
        table.tbl,
        after,
      );
      // Each page goes straight into Blob-backed streams; the table is never
      // materialised as one row array plus one JSON and one CSV string.
      const clean: Record<string, unknown>[] = [];
      for (const row of result.rows) {
        const copy = { ...row };
        delete copy.tenant_id;
        for (const field of hidden) delete copy[field];
        clean.push(copy);
      }
      if (clean.length > 0) {
        rows += clean.length;
        json.push(clean);
        columns ??= exportCsvColumns(table.tbl, clean);
        if (csv.empty) csv.push(exportCsvHeader(columns));
        csv.push(exportCsvRows(clean, columns, timeZone));
      }
      options.onProgress?.({
        table: table.tbl,
        index,
        total: tables.length,
        rows: table.rows,
        done: rows,
      });
      if (
        !result.has_more ||
        result.rows.length === 0 ||
        result.next_after === after
      ) {
        break;
      }
      after = result.next_after;
    }
    json.addTo(writer, `json/${table.tbl}.json`);
    if (csv.empty) csv.push('\uFEFF');
    csv.addTo(writer, `csv/${table.tbl}.csv`);
    counts.push({ tbl: table.tbl, rows });
  }
  const tenant = await tenantInfo(db);
  const displayName =
    tenant?.display_name || String(shop?.name ?? '') || 'Shop';
  const now = session.exported_at;
  const manifest: ShopExportManifest = {
    format: 'bikri-export',
    version: 2,
    exported_at: now,
    app_version: APP_VERSION,
    tenant: { id: tenant?.id ?? db.tenantId, display_name: displayName },
    tables: Object.fromEntries(counts.map((entry) => [entry.tbl, entry.rows])),
    source: 'server',
    snapshot_seq: session.snapshot_seq,
  };
  writer.add(
    'manifest.json',
    encoder.encode(JSON.stringify(manifest, null, 2)),
  );
  return {
    blob: writer.finish(),
    filename: shopExportFilename(displayName, now, timeZone),
    manifest,
  };
}

/** Pages the server export and builds the same zip as the device export (T-053). */
export async function buildServerExport(
  db: BikriDb,
  staffId: string,
  options: { onProgress?: (progress: ServerExportProgress) => void } = {},
): Promise<{
  blob: Blob;
  filename: string;
  manifest: ShopExportManifest;
}> {
  try {
    return await buildOnce(db, staffId, options);
  } catch (error) {
    // A resumed token can have expired between sessions; start once more, then surface
    // the server's rate-limit message if the shop already exported today.
    if (!expired(error)) throw error;
    clearServerExportSession();
    return buildOnce(db, staffId, options);
  }
}
