import { afterEach, describe, expect, it } from 'vitest';
import { unzip } from '../admin/zip.ts';
import { seedSampleDay } from '../dev/sampleDay.ts';
import { buildShopExport, SHOP_EXPORT_TABLES } from './shopExport.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const TZ = 'Asia/Karachi';
const TODAY = '2026-10-27';

async function sample() {
  const db = await readyDb('shop-export');
  await addShop(db, { name: 'Bikri Mobile', timezone: TZ });
  await seedSampleDay(db, TODAY, NOW);
  return db;
}

describe('full shop export (screens/17 AC 6, 09 §3.3)', () => {
  it('zips every synced table with matching manifest counts, JSON paisa and CSV rupees', async () => {
    const db = await sample();
    const progress: string[] = [];
    const exported = await buildShopExport(db, {
      now: NOW,
      onProgress: (entry) => progress.push(entry.table),
    });
    expect(exported.filename).toMatch(
      /^bikri-export-bikri-mobile-\d{12}\.zip$/u,
    );
    expect(exported.manifest).toMatchObject({
      format: 'bikri-export',
      version: 2,
      exported_at: NOW,
      tenant: { display_name: 'Bikri Mobile' },
    });
    expect(Object.keys(exported.manifest.tables)).toEqual(SHOP_EXPORT_TABLES);
    expect(
      SHOP_EXPORT_TABLES.some((table) =>
        ['outbox', 'kv', 'carts', 'print_jobs', 'stock_levels'].includes(table),
      ),
    ).toBe(false);
    for (const table of SHOP_EXPORT_TABLES) {
      expect(exported.manifest.tables[table]).toBe(
        await db.table(table).count(),
      );
    }
    expect(progress).toEqual(SHOP_EXPORT_TABLES);

    const entries = await unzip(exported.bytes);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('json/sales.json');
    expect(names).toContain('csv/sales.csv');
    expect(names).toHaveLength(1 + SHOP_EXPORT_TABLES.length * 2);
    const text = new TextDecoder();
    const manifest = JSON.parse(
      text.decode(
        entries.find((entry) => entry.name === 'manifest.json')?.data,
      ),
    );
    expect(manifest.tables.sales).toBe(2);

    const jsonSales = JSON.parse(
      text.decode(
        entries.find((entry) => entry.name === 'json/sales.json')?.data,
      ),
    ) as Record<string, unknown>[];
    expect(jsonSales).toHaveLength(2);
    expect(jsonSales[0]?.tenant_id).toBeUndefined();
    expect(jsonSales.map((sale) => sale.total)).toEqual(
      expect.arrayContaining([50000, 100000]),
    );

    const salesCsv = text
      .decode(entries.find((entry) => entry.name === 'csv/sales.csv')?.data)
      .replace(/^\uFEFF/u, '');
    const [header, ...rows] = salesCsv.trim().split('\r\n');
    expect(header).toContain('total');
    expect(header).toContain('created_at');
    expect(rows.some((row) => row.includes('1000.00'))).toBe(true);
    expect(rows.some((row) => row.includes(',50000,'))).toBe(false);
    expect(rows[0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:00/u);
  });
});
