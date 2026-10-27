import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzip } from '../admin/zip.ts';
import { SyncHttpError } from '../sync/client.ts';
import { shopRequest } from '../sync/shopApi.ts';
import {
  buildServerExport,
  clearServerExportSession,
  type ServerExportPage,
  type ServerExportStart,
} from './serverExport.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, readyDb } from './testShop.ts';

vi.mock('../sync/shopApi.ts', () => ({ shopRequest: vi.fn() }));
const request = vi.mocked(shopRequest);

afterEach(() => {
  dropTestDbs();
  sessionStorage.clear();
  vi.clearAllMocks();
});

const start: ServerExportStart = {
  export_id: 'export-token',
  snapshot_seq: 7,
  tables: [
    { tbl: 'products', rows: 2 },
    { tbl: 'sales', rows: 1 },
  ],
};

function page(tbl: string, after: string): ServerExportPage {
  if (tbl === 'products')
    return after === ''
      ? {
          tbl,
          rows: [{ id: 'p1', name_en: 'A' }],
          next_after: 'p1',
          has_more: true,
        }
      : {
          tbl,
          rows: [{ id: 'p2', name_en: 'B' }],
          next_after: 'p2',
          has_more: false,
        };
  return {
    tbl,
    rows: [{ id: 's1', total: 1000 }],
    next_after: 's1',
    has_more: false,
  };
}

describe('owner server export (T-053, 13 §7.3)', () => {
  it('pages every table, builds the server manifest and JSON/CSV zip', async () => {
    const db = await readyDb('server-export');
    await addShop(db, { name: 'Server Shop' });
    request.mockImplementation(async (_db, _staff, path) => {
      if (path === '/export') return start as never;
      const url = new URL(path, 'http://bikri');
      return page(
        url.searchParams.get('tbl') ?? '',
        url.searchParams.get('after') ?? '',
      ) as never;
    });
    const progress: string[] = [];
    const result = await buildServerExport(db, 'st-1', {
      onProgress: (entry) => progress.push(`${entry.table}:${entry.done}`),
    });
    expect(result.manifest).toMatchObject({
      format: 'bikri-export',
      version: 2,
      source: 'server',
      snapshot_seq: 7,
      tenant: { display_name: 'Server Shop' },
      tables: { products: 2, sales: 1 },
    });
    expect(progress).toContain('products:1');
    expect(progress).toContain('products:2');
    const entries = await unzip(result.bytes);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('json/products.json');
    expect(names).toContain('csv/sales.csv');
    const text = new TextDecoder();
    const manifest = JSON.parse(
      text.decode(entries.find((e) => e.name === 'manifest.json')?.data),
    );
    expect(manifest.source).toBe('server');
    const products = JSON.parse(
      text.decode(entries.find((e) => e.name === 'json/products.json')?.data),
    ) as { id: string }[];
    expect(products.map((row) => row.id)).toEqual(['p1', 'p2']);
    const salesCsv = text.decode(
      entries.find((e) => e.name === 'csv/sales.csv')?.data,
    );
    expect(salesCsv).toContain('total');
    expect(salesCsv).toContain('10.00');
    clearServerExportSession();
    expect(sessionStorage.getItem('bikri.server_export')).toBeNull();
  });

  it('starts a fresh export when a resumed token has expired', async () => {
    const db = await readyDb('server-expired');
    await addShop(db, { name: 'Server Shop' });
    let starts = 0;
    request.mockImplementation(async (_db, _staff, path) => {
      if (path === '/export') {
        starts += 1;
        return { ...start, export_id: `token-${starts}` } as never;
      }
      const url = new URL(path, 'http://bikri');
      if (url.searchParams.get('export_id') === 'token-1')
        throw new SyncHttpError(
          'VALIDATION_FAILED',
          400,
          'This export has expired; start a new one',
          {},
          null,
        );
      return page(
        url.searchParams.get('tbl') ?? '',
        url.searchParams.get('after') ?? '',
      ) as never;
    });
    const result = await buildServerExport(db, 'st-1');
    expect(starts).toBe(2);
    expect(result.manifest.snapshot_seq).toBe(7);
  });

  it('resumes the same server export token after a failed page', async () => {
    const db = await readyDb('server-resume');
    await addShop(db, { name: 'Server Shop' });
    let fail = true;
    let starts = 0;
    request.mockImplementation(async (_db, _staff, path) => {
      if (path === '/export') {
        starts += 1;
        return start as never;
      }
      const url = new URL(path, 'http://bikri');
      const tbl = url.searchParams.get('tbl') ?? '';
      if (tbl === 'sales' && fail) {
        fail = false;
        throw new Error('offline');
      }
      return page(tbl, url.searchParams.get('after') ?? '') as never;
    });
    await expect(buildServerExport(db, 'st-1')).rejects.toThrow('offline');
    const resumed = await buildServerExport(db, 'st-1');
    expect(starts).toBe(1);
    expect(resumed.manifest.snapshot_seq).toBe(7);
  });
});
