import { APP_VERSION } from '@bikri/core';
import { type ShopExportManifest, tableCsv } from '../data/shopExport.ts';
import { type ExportStart, exportPage, exportStart } from './api.ts';
import { EXPORT_PAGE, exportFilename } from './format.ts';
import { ZipStoreWriter } from './zip.ts';

export type ExportProgress = { tbl: string; done: number; total: number };

export type BuiltExport = {
  filename: string;
  /** Blob parts are appended per table; no full-archive Uint8Array copy is made. */
  blob: Blob;
  tables: { tbl: string; rows: number }[];
};

class ExportStuck extends Error {
  constructor() {
    super('export page guard');
    this.name = 'ExportStuck';
  }
}

async function readTable(
  tenantId: string,
  tbl: string,
  total: number,
  onProgress: (progress: ExportProgress) => void,
  before: number,
): Promise<Record<string, unknown>[]> {
  if (total === 0) {
    onProgress({ tbl, done: 0, total: 0 });
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  let after = '';
  let complete = false;
  for (let guard = 0; guard < 100_000; guard += 1) {
    const page = await exportPage(tenantId, tbl, after, EXPORT_PAGE, before);
    rows.push(...page.rows);
    onProgress({
      tbl,
      done: rows.length,
      total: Math.max(total, rows.length),
    });
    if (!page.has_more || page.rows.length === 0 || page.next_after === after) {
      complete = true;
      break;
    }
    after = page.next_after;
  }
  if (!complete) throw new ExportStuck();
  return rows;
}

/** Pages the operator export and builds the browser zip (screens/19). */
export async function buildTenantExport(
  tenantId: string,
  onProgress: (progress: ExportProgress) => void,
): Promise<BuiltExport> {
  const start: ExportStart = await exportStart(tenantId);
  // The cutoff comes from the server. A wrong operator clock must not produce a
  // manifest whose table counts and pages disagree.
  const exportedAt = start.exported_at ?? Date.now();
  const encoder = new TextEncoder();
  const writer = new ZipStoreWriter(exportedAt);
  const tables: { tbl: string; rows: number }[] = [];
  for (const table of start.tables) {
    onProgress({ tbl: table.tbl, done: 0, total: table.rows });
    const rows = await readTable(
      tenantId,
      table.tbl,
      table.rows,
      onProgress,
      exportedAt,
    );
    writer.add(`json/${table.tbl}.json`, encoder.encode(JSON.stringify(rows)));
    writer.add(`csv/${table.tbl}.csv`, encoder.encode(tableCsv(rows)));
    tables.push({ tbl: table.tbl, rows: rows.length });
  }
  const manifest: ShopExportManifest = {
    format: 'bikri-export',
    version: 2,
    exported_at: exportedAt,
    app_version: APP_VERSION,
    tenant: {
      id: start.tenant.id,
      display_name: start.tenant.display_name,
    },
    snapshot_seq: start.snapshot_seq,
    tables: Object.fromEntries(tables.map((table) => [table.tbl, table.rows])),
  };
  // The manifest is appended last because its counts are only known after every page.
  writer.add(
    'manifest.json',
    encoder.encode(JSON.stringify(manifest, null, 2)),
  );
  return {
    filename: exportFilename(start.tenant.slug, exportedAt),
    blob: writer.finish(),
    tables,
  };
}
