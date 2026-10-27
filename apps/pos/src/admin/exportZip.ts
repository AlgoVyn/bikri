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
): Promise<Record<string, unknown>[]> {
  if (total === 0) {
    onProgress({ tbl, done: 0, total: 0 });
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  let after = '';
  for (let guard = 0; guard < 100_000; guard += 1) {
    const page = await exportPage(tenantId, tbl, after, EXPORT_PAGE);
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
  const encoder = new TextEncoder();
  const collected: { tbl: string; rows: Record<string, unknown>[] }[] = [];
  for (const table of start.tables) {
    onProgress({ tbl: table.tbl, done: 0, total: table.rows });
    const rows = await readTable(tenantId, table.tbl, table.rows, onProgress);
    collected.push({ tbl: table.tbl, rows });
  }
  const exportedAt = Date.now();
  const manifest = {
    format: 'bikri-export',
    version: 1,
    tenant: start.tenant,
    snapshot_seq: start.snapshot_seq,
    exported_at: exportedAt,
    tables: collected.map((table) => ({
      tbl: table.tbl,
      rows: table.rows.length,
    })),
  };
  const files = [
    { name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest)) },
    ...collected.map((table) => ({
      name: `${table.tbl}.json`,
      data: encoder.encode(JSON.stringify(table.rows)),
    })),
  ];
  return {
    filename: exportFilename(start.tenant.slug, exportedAt),
    bytes: zipStore(files, exportedAt),
    tables: manifest.tables,
  };
}
