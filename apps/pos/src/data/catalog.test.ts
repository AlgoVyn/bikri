import { businessDate } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedSampleDay } from '../dev/sampleDay.ts';
import {
  addCategory,
  BundleRecipeError,
  barcodeOwner,
  CategoryInUseError,
  ComponentInUseError,
  DuplicateBarcodeError,
  DuplicateSkuError,
  duplicateDraft,
  filterAndSortProducts,
  generateBarcode,
  ledgerContext,
  listCategories,
  listProducts,
  moveCategory,
  normaliseBundleItems,
  ProductInUseError,
  type ProductListRow,
  type ProductSort,
  productDetail,
  productStockHistory,
  productStockHistoryPage,
  productsCsv,
  removeCategory,
  removeProduct,
  saveNewProduct,
  saveProductEdit,
  stockHistoryCsv,
  TrackedCostError,
  updateCategory,
} from './catalog.ts';
import { dropTestDbs, freshDb } from './testDb.ts';
import { ReadOnlyError } from './write.ts';

afterEach(dropTestDbs);

const NOW = Date.UTC(2026, 9, 27, 9, 0);
const row = { created_at: NOW, updated_at: NOW, deleted_at: null, rev: 1 };

async function readyDb(prefix = 'cat'): Promise<BikriDb> {
  const db = freshDb(prefix);
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
      name: 'Counter 1',
      code: 'A',
      branch_id: 'br-1',
      is_admin: true,
    },
  });
  return db;
}

const cable = {
  name_en: 'Type-C cable 1 m white',
  brand: 'Anker',
  unit: 'pc',
  price: 149900,
  cost: 110000,
  opening_milli: 20000,
  warranty_days: 30,
  barcodes: ['8901234567890'],
};

describe('products (screens/08)', () => {
  it('does not cache a photo when the read-only guard blocks the save (SYNC-L9)', async () => {
    const db = await readyDb('cat-photo-ro');
    await db.kv.put({
      key: 'tenant_status',
      value: { status: 'read_only', since: 1, learned_at: 2 },
    });
    const puts: string[] = [];
    const cache = {
      put: async (request: Request | string) => {
        puts.push(String(request));
      },
      match: async () => undefined,
      delete: async () => true,
      keys: async () => [],
    };
    vi.stubGlobal('caches', { open: async () => cache });
    try {
      const ctx = await ledgerContext(db, 'st-1');
      await expect(
        saveNewProduct(
          db,
          {
            ...cable,
            photo: {
              blob: new Blob(['img']),
              sha256: 'a'.repeat(64),
              ext: 'webp',
            },
          },
          ctx,
          { now: NOW },
        ),
      ).rejects.toBeInstanceOf(ReadOnlyError);
      expect(puts).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('AC 1: cost Rs 1,100 and opening 20 give on hand 20, avg and last cost 110000', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(db, cable, ctx, { now: NOW });
    const detail = await productDetail(db, p.id, NOW);
    expect(detail?.onHand).toBe(20000);
    expect(detail?.product).toMatchObject({
      avg_cost: 110000,
      last_cost: 110000,
      sku: expect.stringMatching(/^TYP-/u),
    });
    expect(
      detail?.history
        .filter((h) => h.kind === 'movement')
        .map((h) => [h.movement.reason_code, h.balanceAfter, h.staffName]),
    ).toEqual([['opening', 20000, 'Adnan']]);
    expect(detail?.barcodes.map((b) => b.barcode)).toEqual(['8901234567890']);
  });

  it('pages a long stock history and keeps the full CSV source', async () => {
    const db = await readyDb('cat-history');
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(
      db,
      { ...cable, opening_milli: 20000, barcodes: [] },
      ctx,
      { now: NOW - 20_000 },
    );
    await db.stock_movements.bulkAdd(
      Array.from({ length: 250 }, (_, index) => ({
        id: `mv-${index}`,
        product_id: p.id,
        qty_delta_milli: 1,
        reason_code: 'entry_fix',
        ref_type: 'adjustment',
        ref_id: null,
        unit_cost: null,
        note: '',
        branch_id: 'br-1',
        device_id: 'dev-1',
        staff_id: 'st-1',
        business_date: businessDate(NOW),
        created_at: NOW - 250 + index,
      })) as never,
    );
    await db.stock_levels.put({
      product_id: p.id,
      on_hand_milli: 20_250,
    });
    const first = await productDetail(db, p.id, NOW, 200);
    expect(first?.history).toHaveLength(200);
    expect(first?.hasMoreHistory).toBe(true);
    expect(first?.history[0]).toMatchObject({
      kind: 'movement',
      movement: { created_at: NOW - 1 },
      balanceAfter: 20_250,
    });
    expect(first?.history[1]?.balanceAfter).toBe(20_249);
    const all = await productDetail(db, p.id, NOW, 300);
    expect(all?.history).toHaveLength(251);
    expect(all?.hasMoreHistory).toBe(false);
    expect(await productStockHistory(db, p.id)).toHaveLength(251);
  });

  it('links sale, refund, void and purchase movements to their documents', async () => {
    const db = await readyDb('cat-refs');
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(
      db,
      { ...cable, opening_milli: 0, barcodes: [] },
      ctx,
      { now: NOW - 20_000 },
    );
    await db.sales.bulkAdd([
      { id: 's1', invoice_no: 'A-A-1', business_date: businessDate(NOW) },
      { id: 's2', invoice_no: 'A-A-2', business_date: businessDate(NOW) },
    ] as never);
    await db.refunds.bulkAdd([
      { id: 'r1', sale_id: 's1' },
      { id: 'r2', sale_id: 's2' },
      { id: 'r3', sale_id: 'missing-sale' },
    ] as never);
    await db.sale_voids.bulkAdd([
      { id: 'v1', sale_id: 's1' },
      { id: 'v2', sale_id: null },
    ] as never);
    await db.purchases.bulkAdd([
      { id: 'p1', supplier_id: 'sup-1', supplier_invoice_no: 'SUP-9' },
      { id: 'p2', supplier_id: 5, supplier_invoice_no: 'SUP-10' },
      { id: 'p3', supplier_id: 'sup-gone', supplier_invoice_no: 'SUP-11' },
      { id: 'p4', supplier_id: 'sup-missing', supplier_invoice_no: 'SUP-12' },
    ] as never);
    await db.suppliers.bulkAdd([
      {
        id: 'sup-1',
        name: 'Metro',
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null,
        rev: 1,
      },
      {
        id: 'sup-gone',
        name: 'Closed',
        created_at: NOW,
        updated_at: NOW,
        deleted_at: NOW + 1,
        rev: 1,
      },
    ] as never);
    const movement = (
      id: string,
      reason_code: string,
      ref_type: string | null,
      ref_id: string | null,
      created_at: number,
    ) => ({
      id,
      product_id: p.id,
      qty_delta_milli: 1,
      reason_code,
      ref_type,
      ref_id,
      unit_cost: null,
      note: '',
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: businessDate(NOW),
      created_at,
    });
    await db.stock_movements.bulkAdd([
      movement('m-sale', 'sale', 'sale', 's1', NOW - 4),
      movement('m-sale-dup', 'sale', 'sale', 's1', NOW - 5),
      movement('m-sale-missing', 'sale', 'sale', 'missing-sale', NOW - 6),
      movement('m-refund', 'refund_return', 'refund', 'r1', NOW - 3),
      movement('m-refund-linked', 'refund_return', 'refund', 'r2', NOW - 7),
      movement('m-refund-missing', 'refund_return', 'refund', 'r3', NOW - 8),
      movement(
        'm-refund-unknown',
        'refund_return',
        'refund',
        'no-row',
        NOW - 9,
      ),
      movement('m-void', 'void_return', 'void', 'v1', NOW - 2),
      movement('m-void-nosale', 'void_return', 'void', 'v2', NOW - 10),
      movement('m-void-unknown', 'void_return', 'void', 'no-row', NOW - 11),
      movement('m-purchase', 'purchase', 'purchase', 'p1', NOW - 1),
      movement('m-purchase-dup', 'purchase', 'purchase', 'p1', NOW - 12),
      movement('m-purchase-bad', 'purchase', 'purchase', 'p2', NOW - 13),
      movement('m-purchase-gone', 'purchase', 'purchase', 'p3', NOW - 15),
      movement('m-purchase-nosup', 'purchase', 'purchase', 'p4', NOW - 16),
      movement(
        'm-purchase-unknown',
        'purchase',
        'purchase',
        'no-row',
        NOW - 14,
      ),
      movement('m-opening', 'opening', 'opening', p.id, NOW),
      movement('m-adjustment', 'entry_fix', 'adjustment', null, NOW + 1),
    ] as never);
    const page = await productStockHistoryPage(db, p.id, 200);
    const refs = new Map(
      page.rows.flatMap((row) =>
        row.kind === 'movement'
          ? [[String(row.movement.id), row.ref] as const]
          : [],
      ),
    );
    expect(refs.get('m-sale')).toEqual({
      kind: 'sale',
      saleId: 's1',
      invoiceNo: 'A-A-1',
      businessDate: businessDate(NOW),
      branchId: '',
    });
    expect(refs.get('m-sale-dup')).toEqual({
      kind: 'sale',
      saleId: 's1',
      invoiceNo: 'A-A-1',
      businessDate: businessDate(NOW),
      branchId: '',
    });
    expect(refs.get('m-sale-missing')).toBeNull();
    expect(refs.get('m-refund')).toEqual({
      kind: 'refund',
      saleId: 's1',
      invoiceNo: 'A-A-1',
      businessDate: businessDate(NOW),
      branchId: '',
    });
    expect(refs.get('m-refund-linked')).toEqual({
      kind: 'refund',
      saleId: 's2',
      invoiceNo: 'A-A-2',
      businessDate: businessDate(NOW),
      branchId: '',
    });
    expect(refs.get('m-refund-missing')).toBeNull();
    expect(refs.get('m-refund-unknown')).toBeNull();
    expect(refs.get('m-void')).toEqual({
      kind: 'void',
      saleId: 's1',
      invoiceNo: 'A-A-1',
      businessDate: businessDate(NOW),
      branchId: '',
    });
    expect(refs.get('m-void-nosale')).toBeNull();
    expect(refs.get('m-void-unknown')).toBeNull();
    expect(refs.get('m-purchase')).toEqual({
      kind: 'purchase',
      purchaseId: 'p1',
      supplierId: 'sup-1',
      invoiceNo: 'SUP-9',
    });
    expect(refs.get('m-purchase-dup')).toEqual({
      kind: 'purchase',
      purchaseId: 'p1',
      supplierId: 'sup-1',
      invoiceNo: 'SUP-9',
    });
    expect(refs.get('m-purchase-bad')).toBeNull();
    expect(refs.get('m-purchase-gone')).toBeNull();
    expect(refs.get('m-purchase-nosup')).toBeNull();
    expect(refs.get('m-purchase-unknown')).toBeNull();
    expect(refs.get('m-opening')).toBeNull();
    expect(refs.get('m-adjustment')).toBeNull();
    // The full-history CSV read does not resolve document links.
    const all = await productStockHistory(db, p.id);
    const saleRow = all.find(
      (row) => row.kind === 'movement' && row.movement.id === 'm-sale',
    );
    expect(saleRow?.kind === 'movement' ? saleRow.ref : null).toBeNull();
  });

  it('pages tracking changes with the movements in their time window', async () => {
    const db = await readyDb('cat-track-page');
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(
      db,
      { ...cable, opening_milli: 20000, barcodes: [] },
      ctx,
      { now: NOW - 20_000 },
    );
    await db.stock_movements.bulkAdd(
      Array.from({ length: 250 }, (_, index) => ({
        id: `mv-track-${index}`,
        product_id: p.id,
        qty_delta_milli: 1,
        reason_code: 'entry_fix',
        ref_type: 'adjustment',
        ref_id: null,
        unit_cost: null,
        note: '',
        branch_id: 'br-1',
        device_id: 'dev-1',
        staff_id: 'st-1',
        business_date: businessDate(NOW),
        created_at: NOW - 250 + index,
      })) as never,
    );
    await db.stock_levels.put({
      product_id: p.id,
      on_hand_milli: 20_250,
    });
    const audit = (created_at: number, id: string) => ({
      id,
      action: 'track_stock_change',
      entity: 'products',
      entity_id: p.id,
      before_json: '{"track_stock":1}',
      after_json: '{"track_stock":0}',
      device_id: 'dev-1',
      staff_id: 'st-1',
      created_at,
    });
    await db.audit_log.bulkAdd([
      audit(NOW - 10, 'audit-new'),
      audit(NOW - 100_000, 'audit-old'),
    ] as never);
    const first = await productDetail(db, p.id, NOW, 200);
    expect(first?.hasMoreHistory).toBe(true);
    expect(first?.history.filter((h) => h.kind === 'tracking')).toHaveLength(1);
    expect(
      first?.history.some(
        (h) => h.kind === 'tracking' && h.audit.id === 'audit-new',
      ),
    ).toBe(true);
    expect(
      first?.history.some(
        (h) => h.kind === 'tracking' && h.audit.id === 'audit-old',
      ),
    ).toBe(false);
    const all = await productDetail(db, p.id, NOW, 300);
    expect(all?.hasMoreHistory).toBe(false);
    expect(all?.history.filter((h) => h.kind === 'tracking')).toHaveLength(2);
    expect(await productStockHistory(db, p.id)).toHaveLength(253);
  });

  it('keeps a malformed tracking audit out of the way', async () => {
    const db = await readyDb('cat-track-bad');
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(
      db,
      { ...cable, opening_milli: 1000, barcodes: [] },
      ctx,
      { now: NOW },
    );
    await db.audit_log.add({
      id: 'audit-bad',
      action: 'track_stock_change',
      entity: 'products',
      entity_id: p.id,
      before_json: '{oops',
      after_json: null,
      device_id: 'dev-1',
      staff_id: 'st-1',
      created_at: NOW + 1,
    } as never);
    const detail = await productDetail(db, p.id, NOW + 2);
    expect(detail?.history[0]).toMatchObject({
      kind: 'tracking',
      trackStock: 0,
      minStockBefore: null,
      minStockAfter: null,
      balanceAfter: 1000,
    });
    expect(detail?.history[1]).toMatchObject({ kind: 'movement' });
  });

  it('shows a tracking-off change in stock history and keeps the old on-hand', async () => {
    const db = await readyDb('cat-track-history');
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(
      db,
      { ...cable, min_stock_milli: 10000 },
      ctx,
      { now: NOW },
    );
    await saveProductEdit(
      db,
      p.id,
      { ...cable, track_stock: false, min_stock_milli: 0 },
      ctx,
      { now: NOW + 1 },
    );
    const detail = await productDetail(db, p.id, NOW + 2);
    expect(detail?.product.track_stock).toBe(0);
    expect(detail?.onHand).toBe(20000);
    expect(detail?.history.map((h) => h.kind)).toEqual([
      'tracking',
      'movement',
    ]);
    expect(detail?.history[0]).toMatchObject({
      kind: 'tracking',
      trackStock: 0,
      minStockBefore: 10000,
      minStockAfter: 0,
      balanceAfter: 20000,
      staffName: 'Adnan',
    });
    expect(detail?.history[1]).toMatchObject({
      kind: 'movement',
      balanceAfter: 20000,
    });
    expect(await db.stock_movements.count()).toBe(1);
    expect((await db.audit_log.toArray()).map((a) => a.action)).toEqual([
      'track_stock_change',
    ]);
  });

  it("uses each sale's tax snapshot in the 14-day revenue", async () => {
    const db = await readyDb('cat-tax');
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(
      db,
      { ...cable, opening_milli: 0, barcodes: [] },
      ctx,
      { now: NOW },
    );
    const date = businessDate(NOW);
    await db.sales.bulkAdd([
      {
        id: 's-inc',
        business_date: date,
        status: 'completed',
        tax_inclusive: 1,
        device_id: 'dev-1',
        created_at: NOW,
      },
      {
        id: 's-exc',
        business_date: date,
        status: 'completed',
        tax_inclusive: 0,
        device_id: 'dev-1',
        created_at: NOW,
      },
    ] as never);
    await db.sale_lines.bulkAdd([
      {
        id: 'l-inc',
        sale_id: 's-inc',
        product_id: p.id,
        business_date: date,
        qty_milli: 1000,
        net: 11000,
        bill_discount_alloc: 0,
        tax_alloc: 1000,
        created_at: NOW,
      },
      {
        id: 'l-exc',
        sale_id: 's-exc',
        product_id: p.id,
        business_date: date,
        qty_milli: 1000,
        net: 11000,
        bill_discount_alloc: 0,
        tax_alloc: 1000,
        created_at: NOW,
      },
    ] as never);
    const detail = await productDetail(db, p.id, NOW);
    const today = detail?.last14.find((day) => day.date === date);
    // Inclusive: 11,000 − 1,000 tax; exclusive: the full 11,000.
    expect(today).toMatchObject({ qty: 2000, revenue: 21000 });
  });

  it('AC 2: a barcode used by another active product is refused with its name; SKUs are unique', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const first = await saveNewProduct(db, { ...cable, sku: 'CAB-1' }, ctx);
    const err = await saveNewProduct(
      db,
      { name_en: 'Other', price: 100, barcodes: ['8901234567890'] },
      ctx,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateBarcodeError);
    expect(err.ownerName).toBe('Type-C cable 1 m white');
    await expect(
      saveNewProduct(db, { name_en: 'Other', price: 100, sku: 'CAB-1' }, ctx),
    ).rejects.toBeInstanceOf(DuplicateSkuError);
    await expect(
      saveNewProduct(
        db,
        { name_en: 'Other', price: 100, barcodes: ['111', '111'] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(DuplicateBarcodeError);
    // Editing the owner itself keeps its barcode; deleting it frees the barcode.
    await saveProductEdit(
      db,
      first.id,
      { ...cable, sku: 'CAB-1', price: 159900 },
      ctx,
    );
    expect((await barcodeOwner(db, '8901234567890'))?.id).toBe(first.id);
    await removeProduct(db, first.id, ctx);
    expect(await barcodeOwner(db, '8901234567890')).toBeNull();
    expect(await db.products.count()).toBe(1);
  });

  it('edit: price is audited; tracked cost is locked; untracked cost is editable', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(db, cable, ctx, { now: NOW });
    await saveProductEdit(
      db,
      p.id,
      { ...cable, price: 159900, barcodes: ['222333444'] },
      ctx,
      { now: NOW + 1 },
    );
    const after = await db.products.get(p.id);
    expect(after).toMatchObject({
      price: 159900,
      last_cost: 110000,
      avg_cost: 110000,
    });
    await expect(
      saveProductEdit(
        db,
        p.id,
        { ...cable, price: 159900, cost: 120000 },
        ctx,
        { now: NOW + 2 },
      ),
    ).rejects.toBeInstanceOf(TrackedCostError);
    const audits = (await db.audit_log.toArray())
      .filter((audit) => audit.entity_id === p.id)
      .map((a) => [a.action, a.before_json, a.after_json]);
    expect(audits).toEqual([
      ['price_change', '{"price":149900}', '{"price":159900}'],
    ]);
    const live = (await db.product_barcodes.toArray())
      .filter((b) => !b.deleted_at)
      .map((b) => b.barcode);
    expect(live).toEqual(['222333444']);
    expect(await db.stock_movements.count()).toBe(1);

    const service = await saveNewProduct(
      db,
      {
        ...cable,
        name_en: 'Repair service',
        sku: 'SRV-1',
        barcodes: [],
        track_stock: false,
        opening_milli: 0,
        cost: 5000,
      },
      ctx,
      { now: NOW + 3 },
    );
    await saveProductEdit(
      db,
      service.id,
      {
        name_en: 'Repair service',
        price: 149900,
        cost: 6000,
        track_stock: false,
      },
      ctx,
      { now: NOW + 4 },
    );
    expect((await db.products.get(service.id))?.last_cost).toBe(6000);
  });

  it('leaves barcodes untouched when an edit omits them', async () => {
    const db = await readyDb('cat-barcode-keep');
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(db, cable, ctx, { now: NOW });
    await saveProductEdit(
      db,
      p.id,
      { name_en: 'Renamed cable', price: 149900 },
      ctx,
      { now: NOW + 1 },
    );
    const live = (await db.product_barcodes.toArray())
      .filter((b) => !b.deleted_at)
      .map((b) => b.barcode);
    expect(live).toEqual(['8901234567890']);
  });

  it('refuses to delete a product an unsynced sale line points at', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    await seedSampleDay(db, '2026-10-27', NOW);
    const charger = (await db.products.toArray())[0];
    if (!charger) throw new Error('missing');
    await expect(removeProduct(db, charger.id, ctx)).rejects.toBeInstanceOf(
      ProductInUseError,
    );
  });

  it('stores and updates the Urdu category name', async () => {
    const db = await readyDb('cat-ur');
    const category = await addCategory(db, 'Cables', 't1', {}, 'کیبل');
    expect(category.name_ur).toBe('کیبل');
    await updateCategory(db, category.id, { name_ur: 'کیبلز' });
    expect((await db.categories.get(category.id))?.name_ur).toBe('کیبلز');
  });

  it('AC 7: Duplicate keeps details and clears SKU, barcodes and opening stock; saving makes a new product', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const cat = await addCategory(db, 'Cables');
    const p = await saveNewProduct(db, { ...cable, category_id: cat.id }, ctx);
    const draft = duplicateDraft((await db.products.get(p.id)) ?? p);
    expect(draft).toMatchObject({
      name_en: cable.name_en,
      brand: 'Anker',
      category_id: cat.id,
      price: 149900,
      cost: 110000,
      unit: 'pc',
      warranty_days: 30,
      sku: '',
      barcodes: [],
      opening_milli: 0,
    });
    const copy = await saveNewProduct(
      db,
      { ...draft, name_en: 'Type-C cable 1 m black' },
      ctx,
    );
    expect(copy.id).not.toBe(p.id);
    expect(copy.sku).not.toBe(p.sku);
    expect((await productDetail(db, copy.id))?.onHand).toBe(0);
  });

  it('lists with word search, filters and sorts, and 30-day sold', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    await saveNewProduct(db, cable, ctx);
    await saveNewProduct(
      db,
      {
        ...cable,
        name_en: 'Type-C cable 1 m black',
        barcodes: [],
        opening_milli: 0,
      },
      ctx,
    );
    await saveNewProduct(
      db,
      { name_en: 'Repair service', price: 50000, track_stock: false },
      ctx,
    );
    await saveNewProduct(
      db,
      {
        name_en: 'Earbuds',
        price: 250000,
        opening_milli: 2000,
        min_stock_milli: 3000,
      },
      ctx,
    );
    expect(
      (await listProducts(db, { query: 'cable white' })).map(
        (r) => r.product.name_en,
      ),
    ).toEqual(['Type-C cable 1 m white']);
    expect((await listProducts(db, { query: '8901234567890' })).length).toBe(1);
    expect(
      (await listProducts(db, { stock: 'out' })).map((r) => r.product.name_en),
    ).toEqual(['Type-C cable 1 m black']);
    expect(
      (await listProducts(db, { stock: 'low' })).map((r) => r.product.name_en),
    ).toEqual(['Earbuds']);
    expect(
      (await listProducts(db, { stock: 'untracked' })).map(
        (r) => r.product.name_en,
      ),
    ).toEqual(['Repair service']);
    expect(
      (await listProducts(db, { sort: 'price' })).map(
        (r) => r.product.name_en,
      )[0],
    ).toBe('Repair service');
    await seedSampleDay(db, businessDate(Date.now()));
    const best = await listProducts(db, { sort: 'best' });
    expect(best[0]?.product.name_en).toBe('Charger');
    expect(best[0]?.sold30).toBe(2000);
  });

  it('sorts every product column in both directions', () => {
    const row = (
      name: string,
      price: number,
      cost: number,
      stock: number,
      sold: number,
      category: string | null,
    ): ProductListRow =>
      ({
        product: {
          id: name,
          name_en: name,
          price,
          avg_cost: cost,
          category_id: category ? `cat-${category}` : null,
        },
        category: category
          ? { id: `cat-${category}`, name_en: category, name_ur: category }
          : null,
        onHand: stock,
        sold30: sold,
        barcodes: [],
        stockState: 'ok',
      }) as unknown as ProductListRow;
    const rows = [
      row('Alpha', 300, 200, 3, 5, 'Phones'),
      row('Bravo', 100, 90, 1, 20, 'Cables'),
      row('Charlie', 500, 400, 2, 10, null),
    ];
    const names = (
      input: ProductListRow[],
      sort: ProductSort,
      direction: 'asc' | 'desc',
    ) =>
      filterAndSortProducts(input, { sort, direction }).map(
        (item) => item.product.name_en,
      );
    expect(names(rows, 'name', 'asc')).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(names(rows, 'name', 'desc')).toEqual(['Charlie', 'Bravo', 'Alpha']);
    expect(names(rows, 'category', 'asc')).toEqual([
      'Bravo',
      'Alpha',
      'Charlie',
    ]);
    expect(names(rows, 'category', 'desc')).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
    expect(names(rows, 'price', 'asc')).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(names(rows, 'price', 'desc')).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(names(rows, 'stock', 'asc')).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect(names(rows, 'stock', 'desc')).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(names(rows, 'cost', 'asc')).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(names(rows, 'cost', 'desc')).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(names(rows, 'margin', 'asc')).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect(names(rows, 'margin', 'desc')).toEqual([
      'Alpha',
      'Charlie',
      'Bravo',
    ]);
    expect(names(rows, 'best', 'asc')).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(names(rows, 'best', 'desc')).toEqual(['Bravo', 'Charlie', 'Alpha']);

    // Defaults: name ascending, Sold best-first, and a name tiebreak for equal values.
    expect(
      filterAndSortProducts(rows, {}).map((item) => item.product.name_en),
    ).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(
      filterAndSortProducts(rows, { sort: 'best' }).map(
        (item) => item.product.name_en,
      )[0],
    ).toBe('Bravo');
    const tied = [
      row('Zed', 100, 50, 2, 1, 'Phones'),
      row('Abe', 100, 50, 2, 1, 'Phones'),
    ];
    for (const sort of [
      'category',
      'price',
      'stock',
      'cost',
      'margin',
      'best',
    ] as const) {
      expect(names(tied, sort, 'desc')).toEqual(['Abe', 'Zed']);
    }

    // Empty categories and margins sort last; two empties fall back to name.
    const partial = [
      row('No price', 0, 0, 1, 0, null),
      row('Zero price', 0, 0, 1, 0, null),
      row('No category', 100, 50, 1, 0, null),
      row('Phones', 100, 50, 1, 0, 'Phones'),
    ];
    expect(names(partial, 'category', 'asc')).toEqual([
      'Phones',
      'No category',
      'No price',
      'Zero price',
    ]);
    expect(names(partial, 'category', 'desc')).toEqual([
      'Phones',
      'No category',
      'No price',
      'Zero price',
    ]);
    expect(names(partial, 'margin', 'asc')).toEqual([
      'No category',
      'Phones',
      'No price',
      'Zero price',
    ]);
    expect(names(partial, 'margin', 'desc')).toEqual([
      'No category',
      'Phones',
      'No price',
      'Zero price',
    ]);
  });

  it('AC 4: the CSV has cost columns only with cost.view and guards formulas', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    await saveNewProduct(
      db,
      { ...cable, name_en: '=SUM(A1)', brand: 'A, "B"' },
      ctx,
    );
    const rows = await listProducts(db);
    const owner = productsCsv(rows, true);
    const cashier = productsCsv(rows, false);
    expect(owner.split('\r\n')[0]).toBe(
      'name_en,name_ur,category,brand,barcode,sku,price,cost,avg_cost,stock,unit,min_stock,track_stock,kind,sold_30_days',
    );
    expect(cashier.split('\r\n')[0]).toBe(
      'name_en,name_ur,category,brand,barcode,sku,price,stock,unit,min_stock,track_stock,kind,sold_30_days',
    );
    expect(cashier).not.toContain('cost');
    expect(cashier).not.toContain('1100');
    expect(owner.split('\r\n')[1]).toBe(
      `'=SUM(A1),,,"A, ""B""",'8901234567890,${rows[0]?.product.sku},1499,1100,1100,20,pc,0,1,simple,0`,
    );
  });

  it('generates in-store barcodes: 12 digits starting with 2, unique', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    await saveNewProduct(
      db,
      { name_en: 'X', price: 1, barcodes: ['200000000000'] },
      ctx,
    );
    let calls = 0;
    const code = await generateBarcode(db, (n) => {
      calls += 1;
      return new Uint8Array(n).fill(calls === 1 ? 0 : 1);
    });
    expect(code).toBe('211111111111');
    expect(calls).toBe(2);
  });
});

describe('categories', () => {
  it('moves categories that share a sort_order', async () => {
    const db = await readyDb();
    const a = await addCategory(db, 'A');
    const b = await addCategory(db, 'B');
    await db.categories.update(a.id, { sort_order: 5 });
    await db.categories.update(b.id, { sort_order: 5 });
    await moveCategory(db, b.id, -1);
    const rows = await listCategories(db);
    const moved = rows.find((row) => row.id === b.id);
    const other = rows.find((row) => row.id === a.id);
    expect(Number(moved?.sort_order)).toBeLessThan(Number(other?.sort_order));
    await moveCategory(db, b.id, 1);
    const back = await listCategories(db);
    expect(
      Number(back.find((row) => row.id === b.id)?.sort_order),
    ).toBeGreaterThan(Number(back.find((row) => row.id === a.id)?.sort_order));
  });

  it('adds in order, renames, recolours, moves, and refuses delete while in use', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const a = await addCategory(db, 'Chargers');
    const b = await addCategory(db, 'Cables');
    const wired = await addCategory(db, 'Syncable', 't1', {
      actor: 'st-1',
    });
    const wiredOp = await db.outbox
      .where('[tbl+row_id]')
      .equals(['categories', wired.id])
      .first();
    expect(wiredOp?.row?.updated_by).toBe('st-1');
    await removeCategory(db, wired.id, { actor: 'st-1' });
    await updateCategory(db, b.id, { name_en: 'Cables & leads', color: 't3' });
    await moveCategory(db, b.id, -1);
    expect(
      (await listCategories(db)).map((c) => [c.name_en, c.sort_order, c.color]),
    ).toEqual([
      ['Cables & leads', 1, 't3'],
      ['Chargers', 2, 't1'],
    ]);
    await saveNewProduct(
      db,
      { name_en: 'Fast charger', price: 1, category_id: a.id },
      ctx,
    );
    const err = await removeCategory(db, a.id).catch((e) => e);
    expect(err).toBeInstanceOf(CategoryInUseError);
    expect(err.count).toBe(1);
    await removeCategory(db, b.id);
    expect(
      (await listCategories(db)).map((c) => [c.name_en, c.productCount]),
    ).toEqual([['Chargers', 1]]);
  });
});

describe('two shops on one till (I-till)', () => {
  it("never shows one shop's products, barcodes or categories in the other", async () => {
    const a = await readyDb('shop-a');
    const b = await readyDb('shop-b');
    await saveNewProduct(a, cable, await ledgerContext(a, 'st-1'));
    await addCategory(a, 'Cables');
    expect(await listProducts(b)).toEqual([]);
    expect(await listCategories(b)).toEqual([]);
    expect(await barcodeOwner(b, '8901234567890')).toBeNull();
    // The same barcode is free to use in the other shop.
    await saveNewProduct(b, cable, await ledgerContext(b, 'st-1'));
    expect((await listProducts(b)).length).toBe(1);
    expect((await listProducts(a)).length).toBe(1);
  });
});

it('writeAction is used for each catalog change (one outbox tx per save)', async () => {
  const db = await readyDb();
  await saveNewProduct(db, cable, await ledgerContext(db, 'st-1'));
  const txs = new Set((await db.outbox.toArray()).map((o) => o.tx_id));
  expect(txs.size).toBe(1);
});

describe('bundles (screens/08, v1.1)', () => {
  async function bundleShop() {
    const db = await readyDb('bundle');
    const ctx = await ledgerContext(db, 'st-1');
    const phone = await saveNewProduct(
      db,
      {
        ...cable,
        name_en: 'Phone',
        sku: 'PHONE-1',
        barcodes: ['1111111111111'],
        price: 5000000,
        cost: 4500000,
        opening_milli: 6000,
      },
      ctx,
    );
    const charger = await saveNewProduct(
      db,
      {
        ...cable,
        name_en: 'Charger',
        sku: 'CHARGER-1',
        barcodes: ['2222222222222'],
        price: 130000,
        cost: 90000,
        opening_milli: 10000,
      },
      ctx,
    );
    const bundle = await saveNewProduct(
      db,
      {
        name_en: 'Starter Pack',
        sku: 'BND-1',
        unit: 'set',
        price: 5000000,
        cost: 0,
        track_stock: false,
        kind: 'bundle',
        bundle_items: [
          { component_product_id: phone.id, qty_milli: 1000 },
          { component_product_id: charger.id, qty_milli: 1000 },
        ],
      },
      ctx,
    );
    return { db, ctx, phone, charger, bundle };
  }

  it('saves the product kind and recipe, and derives list/detail figures', async () => {
    const { db, phone, charger, bundle } = await bundleShop();
    const stored = await db.products.get(bundle.id);
    expect(stored?.kind).toBe('bundle');
    expect(stored?.track_stock).toBe(0);
    expect(
      await db.bundle_items.where('bundle_id').equals(bundle.id).count(),
    ).toBe(2);
    const rows = await listProducts(db);
    const row = rows.find((candidate) => candidate.product.id === bundle.id);
    expect(row?.bundle?.items.map((item) => item.product.id)).toEqual([
      phone.id,
      charger.id,
    ]);
    expect(row?.bundle?.availability).toBe(6);
    expect(row?.bundle?.itemsTotal).toBe(5130000);
    expect(row?.onHand).toBe(6000);
    const detail = await productDetail(db, bundle.id, NOW);
    expect(detail?.bundle?.cost).toBe(4590000);
    expect(detail?.history).toEqual([]);
    const csv = productsCsv(rows, true);
    expect(csv).toContain('BND-1');
    expect(csv).toContain(',bundle,');
  });

  it('merges duplicate components and rejects invalid recipes', async () => {
    const { db, phone, charger, bundle } = await bundleShop();
    const merged = await normaliseBundleItems(db, bundle.id, [
      { component_product_id: phone.id, qty_milli: 1000 },
      { component_product_id: phone.id, qty_milli: 2000 },
      { component_product_id: charger.id, qty_milli: 500 },
    ]);
    expect(merged.items).toHaveLength(2);
    expect(merged.items[0]?.qty_milli).toBe(3000);
    await expect(
      normaliseBundleItems(db, bundle.id, []),
    ).rejects.toBeInstanceOf(BundleRecipeError);
    await expect(
      normaliseBundleItems(db, bundle.id, [
        { component_product_id: bundle.id, qty_milli: 1000 },
      ]),
    ).rejects.toBeInstanceOf(BundleRecipeError);
    await expect(
      normaliseBundleItems(db, bundle.id, [
        { component_product_id: phone.id, qty_milli: 0 },
      ]),
    ).rejects.toBeInstanceOf(BundleRecipeError);
    await expect(
      normaliseBundleItems(db, bundle.id, [
        { component_product_id: phone.id, qty_milli: 1000 },
        { component_product_id: bundle.id, qty_milli: 1000 },
      ]),
    ).rejects.toBeInstanceOf(BundleRecipeError);
  });

  it('edits the recipe and blocks deleting or converting a used component', async () => {
    const { db, ctx, phone, charger, bundle } = await bundleShop();
    await saveProductEdit(
      db,
      bundle.id,
      {
        name_en: 'Starter Pack',
        sku: 'BND-1',
        unit: 'set',
        price: 4900000,
        track_stock: false,
        kind: 'bundle',
        bundle_items: [
          { component_product_id: phone.id, qty_milli: 1000 },
          { component_product_id: charger.id, qty_milli: 2000 },
        ],
      },
      ctx,
    );
    const items = await db.bundle_items
      .where('bundle_id')
      .equals(bundle.id)
      .toArray();
    expect(
      items.filter((item) => !item.deleted_at).map((item) => item.qty_milli),
    ).toEqual([1000, 2000]);
    await expect(removeProduct(db, phone.id, ctx)).rejects.toBeInstanceOf(
      ComponentInUseError,
    );
    await expect(
      saveProductEdit(
        db,
        phone.id,
        {
          name_en: 'Phone',
          sku: 'PHONE-1',
          price: 5000000,
          kind: 'bundle',
          bundle_items: [{ component_product_id: charger.id, qty_milli: 1000 }],
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ComponentInUseError);
  });
});

it('exports the documented stock-history CSV header', () => {
  const csv = stockHistoryCsv(
    [
      {
        at: NOW,
        reason: 'sale',
        qty: '-1',
        balanceAfter: '4',
        note: 'Counter stock',
        by: 'Adnan',
      },
    ],
    'Asia/Karachi',
  );
  expect(csv.split('\r\n')[0]).toBe('date,reason,qty,balance_after,note,by');
  expect(csv).toContain('Counter stock');
  expect(csv).toContain('Adnan');
});
