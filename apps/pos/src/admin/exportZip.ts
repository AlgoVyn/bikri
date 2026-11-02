import { APP_VERSION } from '@bikri/core';
import { type ShopExportManifest, tableCsv } from '../data/shopExport.ts';
import { type ExportStart, exportPage, exportStart } from './api.ts';
import { EXPORT_PAGE, exportFilename } from './format.ts';
import { zipStore } from './zip.ts';

export type ExportProgress = { tbl: string; done: number; total: number };

export type BuiltExport = {
  filename: string;
  bytes: Uint8Array;
  tables: { tbl: string; rows: number }[];
};

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
  for (let guard = 0; guard < 100_000; guard += 1) {
    const page = await exportPage(tenantId, tbl, after, EXPORT_PAGE, before);
    rows.push(...page.rows);
    onProgress({
      tbl,
      done: rows.length,
      total: Math.max(total, rows.length),
    });
    if (!page.has_more || page.rows.length === 0 || page.next_after === after) {
      break;
    }
    after = page.next_after;
  }
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
  const collected: { tbl: string; rows: Record<string, unknown>[] }[] = [];
  for (const table of start.tables) {
    onProgress({ tbl: table.tbl, done: 0, total: table.rows });
    const rows = await readTable(
      tenantId,
      table.tbl,
      table.rows,
      onProgress,
      exportedAt,
    );
    collected.push({ tbl: table.tbl, rows });
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
    tables: Object.fromEntries(
      collected.map((table) => [table.tbl, table.rows.length]),
    ),
  };
  const files = [
    {
      name: 'manifest.json',
      data: encoder.encode(JSON.stringify(manifest, null, 2)),
    },
    ...collected.flatMap((table) => [
      {
        name: `json/${table.tbl}.json`,
        data: encoder.encode(JSON.stringify(table.rows)),
      },
      {
        name: `csv/${table.tbl}.csv`,
        data: encoder.encode(tableCsv(table.rows)),
      },
    ]),
  ];
  return {
    filename: exportFilename(start.tenant.slug, exportedAt),
    bytes: zipStore(files, exportedAt),
    tables: collected.map((table) => ({
      tbl: table.tbl,
      rows: table.rows.length,
    })),
  };
}
