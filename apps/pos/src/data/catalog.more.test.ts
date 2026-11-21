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
  it('shows a refund of an older sale on the 14-day chart', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const product = await saveNewProduct(
      db,
      { name_en: 'Old phone', price: 10000, cost: 5000, opening_milli: 10000 },
      ctx,
      { now: NOW },
    );
    const old = businessDate(NOW - 20 * 86_400_000);
    const today = businessDate(NOW);
    await db.sales.add({
      ...row,
      id: 'old-sale',
      invoice_no: 'A-A-1',
      invoice_seq: 1,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: old,
      line_count: 1,
      items_qty_milli: 1000,
      gross_total: 10000,
      item_discount_total: 0,
      subtotal: 10000,
      bill_discount_type: null,
      bill_discount_value: 0,
      bill_discount: 0,
      tax_rate_bp: 0,
      tax: 0,
      tax_inclusive: 0,
      rounding: 0,
      total: 10000,
      paid_total: 10000,
      udhaar_amount: 0,
      cash_tendered: 10000,
      change_given: 0,
      status: 'paid',
      replaces_sale_id: null,
      note: '',
    } as never);
    await db.sale_lines.add({
      ...row,
      id: 'old-line',
      sale_id: 'old-sale',
      line_no: 1,
      product_id: product.id,
      name_snapshot: 'Old phone',
      sku_snapshot: 'PHN-0001',
      qty_milli: 1000,
      unit_price: 10000,
      gross: 10000,
      discount_type: null,
      discount_value: 0,
      discount: 0,
      net: 10000,
      bill_discount_alloc: 0,
      tax_alloc: 0,
      rounding_alloc: 0,
      unit_cost_snapshot: 5000,
      below_cost: 0,
      serial: null,
      warranty_until: null,
      business_date: old,
    } as never);
    await db.refunds.add({
      id: 'old-refund',
      sale_id: 'old-sale',
      kind: 'whole',
      reason: 'Faulty',
      method: 'cash',
      exact_amount: 10000,
      udhaar_part: 0,
      rounding: 0,
      amount: 10000,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: today,
      created_at: NOW,
    } as never);
    await db.refund_lines.add({
      id: 'old-refund-line',
      refund_id: 'old-refund',
      sale_line_id: 'old-line',
      qty_milli: 1000,
      amount: 10000,
      restock: 1,
      business_date: today,
      created_at: NOW,
    } as never);
    const detail = await productDetail(db, product.id, NOW);
    expect(detail?.last14.at(-1)).toMatchObject({
      qty: -1000,
      revenue: -10000,
    });
  });

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
    const audits = await db.audit_log.toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'track_stock_change',
      entity: 'products',
      entity_id: cab.id,
      before_json: '{"track_stock":1}',
      after_json: '{"track_stock":0}',
    });
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
