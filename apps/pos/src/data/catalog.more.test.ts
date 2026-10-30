import { businessDate } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { seedSampleDay } from '../dev/sampleDay.ts';
import {
  addCategory,
  ledgerContext,
  listCategories,
  listProducts,
  matchesQuery,
  moveCategory,
  productDetail,
  productsCsv,
  referencedByUnsyncedOp,
  removeProduct,
  saveNewProduct,
  saveProductEdit,
  stockStateOf,
  uniqueSku,
  updateCategory,
} from './catalog.ts';
import { searchAll } from './search.ts';
import { dropTestDbs, freshDb } from './testDb.ts';

afterEach(dropTestDbs);

const NOW = Date.UTC(2026, 9, 27, 9, 0);
const row = { created_at: NOW, updated_at: NOW, deleted_at: null, rev: 1 };

async function readyDb(): Promise<BikriDb> {
  const db = freshDb('more');
  await db.branches.add({
    id: 'br-1',
    name: 'Main',
    bill_prefix: 'A',
    is_default: 1,
    ...row,
  });
  await db.staff.add({
    id: 'st-1',
    name: 'Adnan',
    role: 'owner',
    active: 1,
    permissions_json: '{}',
    ...row,
  });
  await db.expense_categories.add({
    id: 'ec-1',
    code: 'rent',
    name: 'Rent',
    sort_order: 1,
    ...row,
  });
  await db.kv.put({
    key: 'device',
    value: {
      id: 'dev-1',
      name: 'C1',
      code: 'A',
      branch_id: 'br-1',
      is_admin: true,
    },
  });
  return db;
}

describe('catalog edge cases', () => {
  it('ledgerContext needs a device and branch', async () => {
    await expect(ledgerContext(freshDb('empty'), 'st-1')).rejects.toThrow(
      /no device or branch/u,
    );
  });

  it('stock state and query matching', () => {
    const p = { id: 'p', track_stock: 1, min_stock_milli: 2000 } as never;
    expect(stockStateOf(p, 0)).toBe('out');
    expect(stockStateOf(p, 2000)).toBe('low');
    expect(stockStateOf(p, 3000)).toBe('ok');
    expect(stockStateOf({ id: 'q', track_stock: 0 } as never, 0)).toBe(
      'untracked',
    );
    const r = {
      product: { name_en: 'A', name_ur: null, brand: null, sku: 'S' },
      barcodes: [],
    } as never;
    expect(matchesQuery(r, '  ')).toBe(true);
    expect(matchesQuery(r, 's')).toBe(true);
  });

  it('untracked products skip opening stock; edit can turn tracking off; sort by stock', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const svc = await saveNewProduct(
      db,
      {
        name_en: 'Repair',
        price: 1000,
        track_stock: false,
        opening_milli: 5000,
      },
      ctx,
    );
    expect(await db.stock_movements.count()).toBe(0);
    const cab = await saveNewProduct(
      db,
      { name_en: 'Cable', price: 1000, opening_milli: 3000 },
      ctx,
    );
    await saveProductEdit(
      db,
      cab.id,
      { name_en: 'Cable', price: 1000, track_stock: false },
      ctx,
    );
    expect((await db.products.get(cab.id))?.track_stock).toBe(0);
    expect(await db.audit_log.count()).toBe(0);
    expect(
      (await listProducts(db, { sort: 'stock' })).map((r) => r.product.id),
    ).toEqual([svc.id, cab.id]);
    await expect(
      saveProductEdit(db, 'missing', { name_en: 'X', price: 1 }, ctx),
    ).rejects.toThrow(/not found/u);
    const csv = productsCsv(await listProducts(db), false);
    expect(csv).toContain('Repair,,,,,');
  });

  it('detail: missing and deleted products, last 14 days skip voided bills', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    expect(await productDetail(db, 'nope')).toBeNull();
    await seedSampleDay(db, businessDate(Date.now()));
    const charger = (await db.products.toArray())[0];
    if (!charger) throw new Error('missing');
    const detail = await productDetail(db, charger.id);
    expect(detail?.last14.at(-1)).toMatchObject({ qty: 2000, revenue: 100000 });
    const sale = (await db.sales.toArray())[0];
    if (sale) await db.sales.update(sale.id, { status: 'void' });
    expect(
      (await productDetail(db, charger.id))?.last14.at(-1)?.qty,
    ).toBeLessThan(3000);
    expect(await referencedByUnsyncedOp(db, charger.id)).toBe(true);
    const lone = await saveNewProduct(
      db,
      { name_en: 'Lone', price: 1, opening_milli: 1000 },
      ctx,
    );
    expect(await referencedByUnsyncedOp(db, lone.id)).toBe(false);
    await removeProduct(db, lone.id, ctx);
    await removeProduct(db, lone.id, ctx);
    expect(await productDetail(db, lone.id)).toBeNull();
    expect(
      (await db.audit_log.toArray()).filter(
        (a) => a.action === 'product_delete',
      ),
    ).toHaveLength(1);
  });

  it('SKUs avoid collisions; categories ignore moves past the ends', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    await saveNewProduct(
      db,
      { name_en: 'Cable', price: 1, sku: 'CAB-0000' },
      ctx,
    );
    const sku = await uniqueSku(db, 'Cable');
    expect(sku).toMatch(/^CAB-/u);
    expect(sku).not.toBe('CAB-0000');
    const a = await addCategory(db, 'A');
    await moveCategory(db, a.id, -1);
    await moveCategory(db, 'missing', 1);
    await updateCategory(db, a.id, { color: 't5' });
    expect(
      (await listCategories(db)).map((c) => [c.name_en, c.color, c.sort_order]),
    ).toEqual([['A', 't5', 1]]);
  });
});

describe('top-bar search', () => {
  it('finds products by words or barcode, customers by name or phone, bills by number', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    await seedSampleDay(db, '2026-10-27', NOW);
    await saveNewProduct(
      db,
      {
        name_en: 'Type-C cable white',
        brand: 'Anker',
        price: 1,
        barcodes: ['555666777'],
      },
      ctx,
    );
    expect(await searchAll(db, '   ')).toEqual([]);
    expect((await searchAll(db, 'anker white')).map((h) => h.title)).toEqual([
      'Type-C cable white',
    ]);
    expect((await searchAll(db, '555666777')).map((h) => h.kind)).toEqual([
      'product',
    ]);
    expect(
      (await searchAll(db, 'bilal')).map((h) => [h.kind, h.title]),
    ).toEqual([['customer', 'Bilal']]);
    expect((await searchAll(db, '0300 111')).map((h) => h.kind)).toEqual([
      'customer',
    ]);
    expect((await searchAll(db, 'a-a-')).map((h) => h.title)).toEqual([
      'A-A-2',
      'A-A-1',
    ]);
    expect((await searchAll(db, 'zzz')).length).toBe(0);
    expect(
      await searchAll(db, 'a-a-', { allDates: false, today: '2026-10-28' }),
    ).toEqual([]);
    expect(
      (
        await searchAll(db, 'a-a-', {
          allDates: false,
          today: '2026-10-27',
        })
      ).length,
    ).toBe(2);
  });
});
