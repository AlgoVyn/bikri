import { parseMoneyToPaisa } from '@bikri/core';
import Papa from 'papaparse';
import { afterEach, describe, expect, it } from 'vitest';
import { addCategory, ledgerContext, saveNewProduct } from './catalog.ts';
import {
  autoMap,
  errorsCsv,
  IMPORT_CHUNK,
  previewImport,
  runImport,
  TEMPLATE_COLUMNS,
  templateCsv,
} from './importProducts.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const grid = (csv: string) =>
  Papa.parse<string[]>(csv, { skipEmptyLines: true }).data;
const HEAD = TEMPLATE_COLUMNS.join(',');

async function shop(prefix: string) {
  const db = await readyDb(prefix);
  const ctx = await ledgerContext(db, 'st-1');
  return { db, ctx };
}

describe('import spreadsheet (screens/08)', () => {
  it('the template maps itself; English and Roman Urdu headers auto-match', () => {
    const [head] = grid(templateCsv());
    expect(head).toEqual([...TEMPLATE_COLUMNS]);
    const m = autoMap(head as string[]);
    expect(Object.keys(m)).toHaveLength(12);
    expect(
      autoMap(['Naam', 'Qeemat', 'Laagat', 'Miqdar', 'Barcode', 'Qisam']),
    ).toEqual({
      name_en: 0,
      price: 1,
      cost: 2,
      stock: 3,
      barcode: 4,
      category: 5,
    });
    expect(autoMap(['Product Name', 'Sale Price', 'Opening Stock'])).toEqual({
      name_en: 0,
      price: 1,
      stock: 2,
    });
  });

  it('AC 5: 1,000 valid template rows import in < 10 s with 1,000 opening movements, ≤ 200 ops per transaction', async () => {
    const { db, ctx } = await shop('imp1');
    const lines = [HEAD];
    for (let i = 0; i < 1000; i += 1) {
      lines.push(
        `Item ${i},,Cables,Anker,89${String(i).padStart(11, '0')},,${100 + i}.50,80,${(i % 9) + 1},pc,2,yes`,
      );
    }
    const g = grid(lines.join('\n'));
    const started = performance.now();
    const preview = await previewImport(db, g, autoMap(g[0] as string[]));
    expect(preview.summary).toEqual({ new: 1000, updates: 0, errors: 0 });
    const progress: number[] = [];
    const result = await runImport(db, preview, ctx, {
      now: NOW,
      onProgress: (d) => progress.push(d),
    });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(result).toEqual({ created: 1000, updated: 0, skipped: 0 });
    expect(progress).toHaveLength(1000 / IMPORT_CHUNK);
    expect(await db.products.count()).toBe(1000);
    const opening = await db.stock_movements

      .filter((m) => m.reason_code === 'opening')
      .toArray();
    expect(opening).toHaveLength(1000);
    expect(opening.every((m) => m.unit_cost === 8000)).toBe(true);
    expect(await db.product_barcodes.count()).toBe(1000);
    expect((await db.categories.toArray()).map((c) => c.name_en)).toEqual([
      'Cables',
    ]);
    const first = (await db.products.toArray()).find(
      (p) => p.name_en === 'Item 7',
    );
    expect(first).toMatchObject({
      price: 10750,
      avg_cost: 8000,
      min_stock_milli: 2000,
      track_stock: 1,
    });
    const perTx = new Map<string, number>();
    for (const op of await db.outbox.toArray())
      perTx.set(String(op.tx_id), (perTx.get(String(op.tx_id)) ?? 0) + 1);
    expect(Math.max(...perTx.values())).toBeLessThanOrEqual(200);
  }, 20_000);

  it('matches by SKU or barcode: updates fields and adds barcodes; stock and cost are ignored', async () => {
    const { db, ctx } = await shop('imp2');
    const a = await saveNewProduct(
      db,
      {
        name_en: 'Cable',
        sku: 'CAB-1',
        price: 45000,
        cost: 30000,
        opening_milli: 5000,
      },
      ctx,
      { now: NOW },
    );
    const b = await saveNewProduct(
      db,
      { name_en: 'Charger', price: 150000, barcodes: ['8902222222222'] },
      ctx,
      { now: NOW },
    );
    const g = grid(
      [
        HEAD,
        ',,,,5550001,CAB-1,499.99,999,50,,,',
        'Fast charger,,,,8902222222222,,,,,,,no',
      ].join('\n'),
    );
    const preview = await previewImport(db, g, autoMap(g[0] as string[]));
    expect(preview.summary).toEqual({ new: 0, updates: 2, errors: 0 });
    expect(preview.rows[0]).toMatchObject({
      productId: a.id,
      ignored: ['stock', 'cost'],
    });
    expect(preview.rows[1]).toMatchObject({ productId: b.id, ignored: [] });
    await runImport(db, preview, ctx, { now: NOW + 1000 });
    expect(await db.products.get(a.id)).toMatchObject({
      name_en: 'Cable',
      price: 49999,
      avg_cost: 30000,
      last_cost: 30000,
    });
    expect(await db.products.get(b.id)).toMatchObject({
      name_en: 'Fast charger',
      price: 150000,
      track_stock: 0,
    });
    expect((await db.stock_levels.get(a.id))?.on_hand_milli).toBe(5000);
    const codes = await db.product_barcodes
      .where('product_id')
      .equals(a.id)
      .toArray();
    expect(codes.map((c) => c.barcode)).toEqual(['5550001']);
    const audit = await db.audit_log

      .filter((r) => r.action === 'price_change')
      .toArray();
    expect(audit.map((r) => r.entity_id)).toEqual([a.id]);
  });

  it('row errors are skipped and listed in import-errors.csv', async () => {
    const { db, ctx } = await shop('imp3');
    await saveNewProduct(
      db,
      { name_en: 'Charger', price: 150000, barcodes: ['8902222222222'] },
      ctx,
      { now: NOW },
    );
    await addCategory(db, 'Cables', 't1', { now: NOW });
    const g = grid(
      [
        HEAD,
        ',,,,,,450,,,,,',
        'No price,,,,,,,,,,,',
        'Bad price,,,,,,abc,,,,,',
        'Taken,,,,8902222222222;7770001,NEW-1,450,,,,,',
        'Good,,cables,,7770001,,450,300,3,pc,,',
        'Repeat,,,,7770001,,450,,,,,',
        'Bad unit,,,,,,450,,,crate,,',
        'Half piece,,,,,,450,,1.5,pc,,',
        'Bad track,,,,,,450,,,,,maybe',
        '"Comma, name",,,,,,1,,,,,',
      ].join('\n'),
    );
    const preview = await previewImport(db, g, autoMap(g[0] as string[]));
    expect(preview.summary).toEqual({ new: 2, updates: 0, errors: 8 });
    const codes = preview.rows.map((r) =>
      r.errors.map((e) => e.code).join('+'),
    );
    expect(codes).toEqual([
      'name_required',
      'price_required',
      'price_invalid',
      'barcode_taken',
      '',
      'barcode_repeat',
      'unit_invalid',
      'stock_invalid',
      'track_invalid',
      '',
    ]);
    expect(preview.rows[3]?.errors[0]?.name).toBe('Charger');
    const csv = errorsCsv(preview, (e) => e.code);
    const out = grid(csv);
    expect(out[0]).toEqual(['line', ...TEMPLATE_COLUMNS, 'errors']);
    expect(out.slice(1).map((r) => r[0])).toEqual([
      '2',
      '3',
      '4',
      '5',
      '7',
      '8',
      '9',
      '10',
    ]);
    const result = await runImport(db, preview, ctx, { now: NOW });
    expect(result).toEqual({ created: 2, updated: 0, skipped: 8 });
    const good = (await db.products.toArray()).find(
      (p) => p.name_en === 'Good',
    );
    const cats = await db.categories.toArray();
    expect(cats).toHaveLength(1);
    expect(good?.category_id).toBe(cats[0]?.id);
    expect(parseMoneyToPaisa('450')).toBe(45000);
  });

  it('isolation: matches only this shop’s products and writes only into this shop', async () => {
    const a = await shop('imp-a');
    const b = await shop('imp-b');
    const bp = await saveNewProduct(
      b.db,
      {
        name_en: 'B cable',
        sku: 'SKU-1',
        price: 100,
        barcodes: ['8901111111111'],
      },
      b.ctx,
      { now: NOW },
    );
    const g = grid(
      [HEAD, 'A cable,,,,8901111111111,SKU-1,450,,2,,,'].join('\n'),
    );
    const preview = await previewImport(a.db, g, autoMap(g[0] as string[]));
    expect(preview.rows[0]).toMatchObject({ action: 'new', productId: null });
    await runImport(a.db, preview, a.ctx, { now: NOW });
    expect(await a.db.products.count()).toBe(1);
    expect(await b.db.products.count()).toBe(1);
    expect(await b.db.products.get(bp.id)).toMatchObject({
      name_en: 'B cable',
      price: 100,
    });
    expect(await b.db.outbox.where('tbl').equals('products').count()).toBe(1);
  });
});
