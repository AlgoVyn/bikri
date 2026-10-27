import { APP_VERSION } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { zipStore } from '../admin/zip.ts';
import { SyncHttpError } from '../sync/client.ts';
import { shopRequest } from '../sync/shopApi.ts';
import { tenantInfo } from './localTenant.ts';
import {
  type ShopExportManifest,
  shopExportFilename,
  tableCsv,
} from './shopExport.ts';

export const SERVER_EXPORT_PAGE = 500;
const SESSION_KEY = 'bikri.server_export';

export type ServerExportTable = { tbl: string; rows: number };

export type ServerExportStart = {
  export_id: string;
  snapshot_seq: number;
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
  after: Record<string, string>;
  done: string[];
  /** A server export token is valid for 2 h (04 §3.8). */
  started_at: number;
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
  if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(SESSION_KEY);
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
  bytes: Uint8Array;
  filename: string;
  manifest: ShopExportManifest;
}> {
  let session = readSession();
  const fresh =
    session !== null &&
    session.tenant_id === db.tenantId &&
    Date.now() - session.started_at < EXPORT_TTL;
  if (session && fresh) session = { ...session, after: {}, done: [] };
  else {
    clearServerExportSession();
    const start = await shopRequest<ServerExportStart>(db, staffId, '/export');
    session = {
      export_id: start.export_id,
      snapshot_seq: start.snapshot_seq,
      tables: start.tables,
      after: {},
      done: [],
      started_at: Date.now(),
      tenant_id: db.tenantId,
    };
    writeSession(session);
  }
  const collected: { tbl: string; rows: Record<string, unknown>[] }[] = [];
  for (const [index, table] of session.tables.entries()) {
    if (session.done.includes(table.tbl)) continue;
    const rows: Record<string, unknown>[] = [];
    let after = session.after[table.tbl] ?? '';
    for (let guard = 0; guard < 100_000; guard += 1) {
      const result = await page(
        db,
        staffId,
        session.export_id,
        table.tbl,
        after,
      );
      rows.push(...result.rows);
      options.onProgress?.({
        table: table.tbl,
        index,
        total: session.tables.length,
        rows: table.rows,
        done: rows.length,
      });
      session.after[table.tbl] = result.next_after;
      writeSession(session);
      if (
        !result.has_more ||
        result.rows.length === 0 ||
        result.next_after === after
      ) {
        session.done.push(table.tbl);
        delete session.after[table.tbl];
        writeSession(session);
        break;
      }
      after = result.next_after;
    }
    collected.push({ tbl: table.tbl, rows });
  }
  const tenant = await tenantInfo(db);
  const shop = await db.shop.get('shop');
  const displayName =
    tenant?.display_name || String(shop?.name ?? '') || 'Shop';
  const now = Date.now();
  const manifest: ShopExportManifest = {
    format: 'bikri-export',
    version: 2,
    exported_at: now,
    app_version: APP_VERSION,
    tenant: { id: tenant?.id ?? db.tenantId, display_name: displayName },
    tables: Object.fromEntries(
      collected.map((entry) => [entry.tbl, entry.rows.length]),
    ),
    source: 'server',
    snapshot_seq: session.snapshot_seq,
  };
  const encoder = new TextEncoder();
  const files: { name: string; data: Uint8Array }[] = [
    {
      name: 'manifest.json',
      data: encoder.encode(JSON.stringify(manifest, null, 2)),
    },
  ];
  for (const entry of collected) {
    files.push({
      name: `json/${entry.tbl}.json`,
      data: encoder.encode(JSON.stringify(entry.rows)),
    });
    files.push({
      name: `csv/${entry.tbl}.csv`,
      data: encoder.encode(tableCsv(entry.rows)),
    });
  }
  return {
    bytes: zipStore(files, now),
    filename: shopExportFilename(displayName, now),
    manifest,
  };
}

/** Pages the server export and builds the same zip as the device export (T-053). */
export async function buildServerExport(
  db: BikriDb,
  staffId: string,
  options: { onProgress?: (progress: ServerExportProgress) => void } = {},
): Promise<{
  bytes: Uint8Array;
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
