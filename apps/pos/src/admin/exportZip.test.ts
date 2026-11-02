import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTenantExport } from './exportZip.ts';
import { unzip } from './zip.ts';

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('operator export', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the server cutoff and writes a v2 zip with JSON and CSV', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('tbl=products')) {
          return json({
            tbl: 'products',
            rows: [{ id: 'p1', name_en: 'Phone', price: 100 }],
            next_after: 'p1',
            has_more: false,
          });
        }
        return json({
          tenant: { id: 't1', slug: 'shop', display_name: 'Shop' },
          snapshot_seq: 4,
          exported_at: 1_700_000_000_000,
          tables: [{ tbl: 'products', rows: 1 }],
        });
      }),
    );
    const built = await buildTenantExport('t1', () => undefined);
    const files = await unzip(built.bytes);
    const names = files.map((file) => file.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('json/products.json');
    expect(names).toContain('csv/products.csv');
    const manifest = JSON.parse(
      new TextDecoder().decode(
        files.find((file) => file.name === 'manifest.json')?.data,
      ),
    ) as {
      version: number;
      exported_at: number;
      tables: Record<string, number>;
    };
    expect(manifest.version).toBe(2);
    expect(manifest.exported_at).toBe(1_700_000_000_000);
    expect(manifest.tables).toEqual({ products: 1 });
    const csv = new TextDecoder().decode(
      files.find((file) => file.name === 'csv/products.csv')?.data,
    );
    expect(csv).toContain('Phone');
    expect(csv).toContain('1.00');
    expect(calls.some((url) => url.includes('before=1700000000000'))).toBe(
      true,
    );
  });
});
