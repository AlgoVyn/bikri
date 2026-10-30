import { businessDate } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { seedSampleDay } from '../dev/sampleDay.ts';
import {
  addCategory,
  barcodeOwner,
  CategoryInUseError,
  DuplicateBarcodeError,
  DuplicateSkuError,
  duplicateDraft,
  generateBarcode,
  ledgerContext,
  listCategories,
  listProducts,
  moveCategory,
  ProductInUseError,
  productDetail,
  productsCsv,
  removeCategory,
  removeProduct,
  saveNewProduct,
  saveProductEdit,
  stockHistoryCsv,
  updateCategory,
} from './catalog.ts';
import { dropTestDbs, freshDb } from './testDb.ts';

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
      detail?.history.map((h) => [
        h.movement.reason_code,
        h.balanceAfter,
        h.staffName,
      ]),
    ).toEqual([['opening', 20000, 'Adnan']]);
    expect(detail?.barcodes.map((b) => b.barcode)).toEqual(['8901234567890']);
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

  it('edit: price change and cost change are audited; cost sets last_cost only; barcodes diff', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(db, cable, ctx, { now: NOW });
    await saveProductEdit(
      db,
      p.id,
      { ...cable, price: 159900, cost: 120000, barcodes: ['222333444'] },
      ctx,
      {
        now: NOW + 1,
      },
    );
    const after = await db.products.get(p.id);
    expect(after).toMatchObject({
      price: 159900,
      last_cost: 120000,
      avg_cost: 110000,
    });
    const audits = (await db.audit_log.toArray()).map((a) => [
      a.action,
      a.before_json,
      a.after_json,
    ]);
    expect(audits).toEqual([
      ['price_change', '{"price":149900}', '{"price":159900}'],
      ['cost_change', '{"last_cost":110000}', '{"last_cost":120000}'],
    ]);
    const live = (await db.product_barcodes.toArray())
      .filter((b) => !b.deleted_at)
      .map((b) => b.barcode);
    expect(live).toEqual(['222333444']);
    expect(await db.stock_movements.count()).toBe(1);
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
    expect(best[0]?.sold30).toBe(3000);
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
      'name_en,name_ur,category,brand,barcode,sku,price,cost,avg_cost,stock,unit,min_stock,track_stock,sold_30_days',
    );
    expect(cashier.split('\r\n')[0]).toBe(
      'name_en,name_ur,category,brand,barcode,sku,price,stock,unit,min_stock,track_stock,sold_30_days',
    );
    expect(cashier).not.toContain('cost');
    expect(cashier).not.toContain('1100');
    expect(owner.split('\r\n')[1]).toBe(
      `'=SUM(A1),,,"A, ""B""",8901234567890,${rows[0]?.product.sku},1499,1100,1100,20,pc,0,1,0`,
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
  it('adds in order, renames, recolours, moves, and refuses delete while in use', async () => {
    const db = await readyDb();
    const ctx = await ledgerContext(db, 'st-1');
    const a = await addCategory(db, 'Chargers');
    const b = await addCategory(db, 'Cables');
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

it('exports the documented stock-history CSV header', () => {
  const csv = stockHistoryCsv(
    [
      {
        at: NOW,
        reason: 'sale',
        qty: '-1',
        balanceAfter: '4',
        by: 'Adnan',
      },
    ],
    'Asia/Karachi',
  );
  expect(csv.split('\r\n')[0]).toBe('date,reason,qty,balance_after,by');
  expect(csv).toContain('Adnan');
});
