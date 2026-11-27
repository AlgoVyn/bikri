import { APP_VERSION } from '@bikri/core';
import {
  ExportStream,
  exportCsvHeader,
  exportCsvRows,
  JsonStream,
  type ShopExportManifest,
} from '../data/shopExport.ts';
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

async function eachPage(
  tenantId: string,
  tbl: string,
  total: number,
  before: number,
  onPage: (rows: Record<string, unknown>[], done: number) => void,
): Promise<number> {
  let after = '';
  let done = 0;
  let complete = total === 0;
  for (let guard = 0; guard < 100_000; guard += 1) {
    if (complete) break;
    const page = await exportPage(tenantId, tbl, after, EXPORT_PAGE, before);
    done += page.rows.length;
    onPage(page.rows, done);
    if (!page.has_more) {
      complete = true;
      break;
    }
    // A page that claims more rows but makes no progress must fail loudly instead of
    // producing a backup that silently stops mid-table.
    if (page.rows.length === 0 || page.next_after === after)
      throw new ExportStuck();
    after = page.next_after;
  }
  if (!complete) throw new ExportStuck();
  return done;
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
    // First pass: learn the CSV column union without retaining a whole table.
    const fields = new Set<string>();
    let count = 0;
    await eachPage(
      tenantId,
      table.tbl,
      table.rows,
      exportedAt,
      (rows, done) => {
        for (const row of rows) {
          for (const field of Object.keys(row)) fields.add(field);
        }
        count += rows.length;
        onProgress({
          tbl: table.tbl,
          done,
          total: Math.max(table.rows, done),
        });
      },
    );
    const columns = [...fields];
    // Second pass: stream JSON and CSV into per-page Blobs, so a 200k-row table
    // never exists as one JS array plus one JSON string plus one CSV string.
    const json = new JsonStream();
    const csv = new ExportStream();
    let csvStarted = false;
    await eachPage(tenantId, table.tbl, table.rows, exportedAt, (rows) => {
      json.push(rows);
      if (rows.length === 0) return;
      if (!csvStarted) {
        csv.push(exportCsvHeader(columns));
        csvStarted = true;
      }
      csv.push(exportCsvRows(rows, columns, 'Asia/Karachi'));
    });
    if (table.rows === 0 && count === 0) csv.push('\uFEFF');
    json.addTo(writer, `json/${table.tbl}.json`);
    csv.addTo(writer, `csv/${table.tbl}.csv`);
    tables.push({ tbl: table.tbl, rows: count });
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
