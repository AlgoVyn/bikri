import type { MasterRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addBundle,
  addProduct,
  bundleBasePriceOf,
  bundleDiscountOf,
  bundleDiscountTotal,
  bundleGroupLines,
  bundleListPriceOf,
  bundleNetPrice,
  bundleQtyOf,
  bundleResidualDiscount,
  cartSignature,
  cartTotals,
  emptyCart,
  findByCode,
  manualDiscountBp,
  parseQtyPrefix,
  removeLine,
  setBundleDiscount,
  shopMoney,
  unitCostOf,
  updateBundlePrice,
  updateBundleQty,
} from './cart.ts';
import {
  buildBundleInfoMap,
  bundleInfoOf,
  duplicateDraft,
  ledgerContext,
  loadBundleRecipe,
  normaliseBundleItems,
  productDetail,
  saveNewProduct,
  soldByProduct,
} from './catalog.ts';
import { refundSale } from './refunds.ts';
import { completeSale } from './sale.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, readyDb, sale } from './testShop.ts';

afterEach(dropTestDbs);

const row = (id: string, extra: Partial<MasterRow> = {}): MasterRow =>
  ({
    id,
    name_en: `P ${id}`,
    sku: `SKU-${id}`,
    price: 1000,
    avg_cost: 500,
    last_cost: 500,
    track_stock: 1,
    unit: 'pc',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    rev: 1,
    ...extra,
  }) as MasterRow;

const item = (component: string, qty_milli = 1000) =>
  row(`item-${component}`, {
    bundle_id: `bnd-${component}`,
    component_product_id: component,
    qty_milli,
    sort_order: 0,
  });

describe('bundle recipe derivation', () => {
  it('skips deleted and missing components and handles untracked recipes', () => {
    const a = row('a', { track_stock: 0, price: 300 });
    const products = new Map([[a.id, a]]);
    const levels = new Map([[a.id, 9_000]]);
    const info = bundleInfoOf(
      'bnd-a',
      [
        item('a', 500),
        item('missing'),
        row('deleted-item', {
          bundle_id: 'bnd-a',
          component_product_id: 'a',
          qty_milli: 1000,
          deleted_at: NOW,
        }),
      ],
      products,
      levels,
      'last',
    );
    expect(info.items).toHaveLength(1);
    expect(info.availability).toBeNull();
    expect(info.limiting).toBeNull();
    expect(info.cost).toBe(250);
    expect(info.itemsTotal).toBe(150);
    const empty = bundleInfoOf('bnd-empty', [], products, levels);
    expect(empty).toMatchObject({
      items: [],
      availability: null,
      cost: 0,
      itemsTotal: 0,
      limiting: null,
    });
  });

  it('finds the limiting tracked component and ignores non-bundle products', () => {
    const a = row('a', { track_stock: 1 });
    const b = row('b', { track_stock: 1 });
    const bundle = row('bundle', { kind: 'bundle', track_stock: 0 });
    const simple = row('simple');
    const products = [a, b, bundle, simple];
    const map = buildBundleInfoMap(
      products,
      [
        { ...item('a', 2000), bundle_id: 'bundle' },
        { ...item('b', 1000), bundle_id: 'bundle' },
      ],
      new Map([
        ['a', 5_000],
        ['b', 4_000],
      ]),
    );
    expect(map.has(simple.id)).toBe(false);
    expect(map.get(bundle.id)?.availability).toBe(2);
    expect(map.get(bundle.id)?.limiting?.product.id).toBe('a');
    expect(map.get(bundle.id)?.items.map((entry) => entry.product.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('bundle cart edge cases', () => {
  const bundle = row('bundle', { kind: 'bundle', track_stock: 0 });
  const a = row('a', {
    avg_cost: 300,
    last_cost: 400,
    image_key: 'products/a/x.webp',
    track_stock: 0,
  });
  const recipe = [{ product: a, qty_milli: 500 }];

  it('copies the image, respects untracked components and ignores missing groups', () => {
    let cart = addBundle(emptyCart('c1'), bundle, recipe, 2, 'avg');
    expect(cart.lines[0]).toMatchObject({
      image_key: 'products/a/x.webp',
      track_stock: 0,
      unit_cost: 300,
      qty_milli: 1000,
    });
    const group = String(cart.lines[0]?.bundle_group);
    cart = updateBundleQty(cart, 'missing', 2, new Map(), 'avg');
    expect(cart.lines).toHaveLength(1);
    cart = updateBundleQty(cart, group, 1, new Map([[a.id, a]]), 'last');
    expect(cart.lines[0]?.unit_cost).toBe(400);
    cart = updateBundleQty(cart, group, 0, new Map(), 'avg');
    expect(cart.lines).toHaveLength(0);
    expect(bundleQtyOf(cart, group)).toBe(0);
  });

  it('handles missing product fields and groups without bundles', () => {
    const bare = {
      id: 'bare',
      price: null,
      name_en: null,
      sku: null,
      unit: null,
      track_stock: 0,
    } as unknown as MasterRow;
    expect(unitCostOf(bare, 'avg')).toBe(0);
    expect(unitCostOf(bare, 'last')).toBe(0);
    const cart = addProduct(emptyCart('c1'), bare, 1000, 'last');
    expect(cart.lines[0]).toMatchObject({
      name: '',
      sku: '',
      unit: 'pc',
      unit_price: 0,
    });
    const merged = addProduct(cart, bare, 1000, 'last');
    expect(merged.lines).toHaveLength(1);
    expect(merged.lines[0]?.list_price).toBe(0);
    expect(bundleGroupLines(cart).size).toBe(0);
    const bareBundle = {
      id: 'bare-bundle',
      price: null,
      name_en: null,
      track_stock: 0,
      kind: 'bundle',
    } as unknown as MasterRow;
    const bareComponent = {
      id: 'bare-component',
      price: null,
      name_en: null,
      sku: null,
      unit: null,
      track_stock: 0,
    } as unknown as MasterRow;
    const bareCart = addBundle(
      emptyCart('c3'),
      bareBundle,
      [{ product: bareComponent, qty_milli: 1000 }],
      1,
      'avg',
    );
    expect(bareCart.lines[0]).toMatchObject({
      name: '',
      sku: '',
      unit: 'pc',
      unit_price: 0,
    });
    const bundleCart = addBundle(emptyCart('c2'), bundle, recipe, 1, 'avg');
    expect(
      bundleResidualDiscount(
        { ...bundleCart, lines: [...bundleCart.lines, cart.lines[0] as never] },
        {
          ...cartTotals(bundleCart, shopMoney(null)),
          lines: [
            ...cartTotals(bundleCart, shopMoney(null)).lines,
            {
              gross: 0,
              discount: 0,
              net: 0,
              bill_discount_alloc: 0,
              tax_alloc: 0,
              rounding_alloc: 0,
              final: 0,
              revenue: 0,
              below_cost: 0,
            },
          ],
        },
      ),
    ).toBe(0);
    expect(bundleGroupLines(bundleCart).size).toBe(1);
    expect(cartSignature(bundleCart)).toContain(
      String(bundleCart.lines[0]?.bundle_group),
    );
    expect(
      removeLine(bundleCart, String(bundleCart.lines[0]?.key)).lines,
    ).toHaveLength(0);
    expect(parseQtyPrefix('3*')).toEqual({ qtyMilli: 3000, rest: '' });
    const group = String(bundleCart.lines[0]?.bundle_group);
    const sparse = {
      ...bundleCart,
      lines: [
        {
          ...(bundleCart.lines[0] as (typeof bundleCart.lines)[number]),
          product_id: null,
          bundle_price: undefined,
          bundle_component_qty_milli: undefined,
          discount_value: undefined,
        },
        {
          ...(bundleCart.lines[1] as (typeof bundleCart.lines)[number]),
        },
        {
          key: 'loose',
          product_id: 'loose',
          name: 'Loose',
          sku: 'L',
          qty_milli: 1000,
          unit_price: 100,
          discount_value: 0,
          unit_cost: 0,
        },
      ],
    } as typeof bundleCart;
    const updated = updateBundleQty(sparse, group, 2, new Map(), 'avg');
    expect(updated.lines).toHaveLength(3);
    expect(cartSignature(sparse)).toContain('"loose"');
  });

  it('edits the whole-bundle price and keeps the list price snapshot', () => {
    let cart = addBundle(emptyCart('c1'), bundle, recipe, 1, 'avg');
    const group = String(cart.lines[0]?.bundle_group);
    expect(bundleListPriceOf(cart, group)).toBe(Number(bundle.price));
    cart = updateBundlePrice(cart, group, 50_000, new Map([[a.id, a]]), 'avg');
    expect(cart.lines.every((line) => line.bundle_price === 50_000)).toBe(true);
    expect(bundleListPriceOf(cart, group)).toBe(Number(bundle.price));
    expect(
      cart.lines.reduce(
        (sum, line) => sum + Number(line.unit_price) * (line.qty_milli / 1000),
        0,
      ),
    ).toBe(50_000);
    const doubled = updateBundleQty(
      cart,
      group,
      2,
      new Map([[a.id, a]]),
      'avg',
    );
    expect(bundleQtyOf(doubled, group)).toBe(2);
    expect(doubled.lines.every((line) => line.bundle_price === 50_000)).toBe(
      true,
    );
    expect(
      updateBundlePrice(cart, group, -1, new Map(), 'avg').lines[0]
        ?.bundle_price,
    ).toBe(50_000);
    const empty = emptyCart('c2');
    expect(bundleListPriceOf(empty, 'missing')).toBe(0);
    expect(updateBundlePrice(empty, 'missing', 100, new Map(), 'avg')).toBe(
      empty,
    );
    expect(updateBundleQty(empty, 'missing', 1, new Map(), 'avg')).toBe(empty);
    expect(bundleBasePriceOf(empty, 'missing')).toBe(0);
    expect(bundleDiscountOf(empty, 'missing')).toBe(0);
    expect(bundleDiscountTotal(empty)).toBe(0);
    expect(
      setBundleDiscount(empty, 'missing', 'amount', 100, new Map(), 'avg'),
    ).toBe(empty);
    expect(bundleNetPrice(1000, 'amount', 0)).toBe(1000);
    expect(bundleNetPrice(1000, 'percent', 0)).toBe(1000);
    expect(bundleNetPrice(0, 'amount', 10)).toBe(0);
    expect(bundleNetPrice(1000, 'amount', 2000)).toBe(0);
    expect(bundleNetPrice(1000, 'percent', 10_000)).toBe(0);
    expect(bundleNetPrice(1000, 'percent', 20_000)).toBe(0);
    const discounted = setBundleDiscount(
      cart,
      group,
      'percent',
      1000,
      new Map([[a.id, a]]),
      'avg',
    );
    expect(discounted.lines[0]?.bundle_price).toBe(45_000);
    expect(discounted.lines[0]?.bundle_discount_value).toBe(1000);
    expect(bundleListPriceOf(discounted, group)).toBe(1000);
    expect(bundleBasePriceOf(discounted, group)).toBe(50_000);
    expect(bundleDiscountOf(discounted, group)).toBe(5_000);
    expect(bundleDiscountTotal(discounted)).toBe(5_000);
    const noBase = {
      ...discounted,
      lines: discounted.lines.map((line) => ({
        ...line,
        bundle_base_price: undefined,
        bundle_list_price: undefined,
        bundle_price: 12_000,
      })),
    };
    expect(bundleDiscountOf(noBase, group)).toBe(0);
    const noPrice = {
      ...discounted,
      lines: discounted.lines.map((line) => ({
        ...line,
        bundle_price: undefined,
      })),
    };
    expect(bundleDiscountOf(noPrice, group)).toBe(50_000);
    const zeroQty = {
      ...discounted,
      lines: discounted.lines.map((line) => ({
        ...line,
        bundle_qty: 0,
      })),
    };
    expect(bundleDiscountTotal(zeroQty)).toBe(0);
    const missingQty = {
      ...discounted,
      lines: discounted.lines.map((line) => ({
        ...line,
        bundle_qty: undefined,
      })),
    };
    expect(bundleDiscountTotal(missingQty)).toBe(0);
    expect(
      setBundleDiscount(
        cart,
        group,
        'amount',
        10_000,
        new Map([[a.id, a]]),
        'avg',
      ).lines[0]?.bundle_price,
    ).toBe(40_000);
    const noQty = {
      ...cart,
      lines: cart.lines.map((line) => ({
        ...line,
        bundle_qty: undefined,
      })),
    };
    expect(
      updateBundlePrice(noQty, group, 100, new Map([[a.id, a]]), 'avg'),
    ).toBe(noQty);
    expect(
      setBundleDiscount(noQty, group, 'amount', 100, new Map(), 'avg'),
    ).toBe(noQty);
  });

  it('rejects more recipe rows than the cart can hold', () => {
    const full = {
      ...emptyCart('c1'),
      lines: Array.from({ length: 60 }, (_, i) => ({
        key: `k${i}`,
        product_id: `p${i}`,
        name: 'P',
        sku: 'S',
        qty_milli: 1000,
        unit_price: 1,
        discount_value: 0,
        unit_cost: 0,
      })),
    };
    expect(() => addBundle(full, bundle, recipe, 1, 'avg')).toThrow();
  });
});

describe('bundle product CRUD', () => {
  async function shop() {
    const db = await readyDb('bundle-edge');
    const ctx = await ledgerContext(db, 'st-1');
    const first = await saveNewProduct(
      db,
      { name_en: 'One', sku: 'ONE', price: 1000, cost: 500 },
      ctx,
      { now: NOW },
    );
    const second = await saveNewProduct(
      db,
      { name_en: 'Two', sku: 'TWO', price: 2000, cost: 700 },
      ctx,
      { now: NOW },
    );
    const bundle = await saveNewProduct(
      db,
      {
        name_en: 'Pack',
        sku: 'PACK',
        unit: 'set',
        price: 2500,
        kind: 'bundle',
        track_stock: false,
        bundle_items: [
          { component_product_id: first.id, qty_milli: 1000 },
          { component_product_id: second.id, qty_milli: 1000 },
        ],
      },
      ctx,
      { now: NOW },
    );
    return { db, ctx, first, second, bundle };
  }

  it('ignores barcodes that point at a missing product', async () => {
    const { db } = await shop();
    await db.product_barcodes.add({
      id: 'pb-missing',
      product_id: 'missing-product',
      barcode: '9999999999999',
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
    });
    expect(await findByCode(db, '9999999999999')).toBeNull();
  });

  it('rejects more than 20 components and deleted/nested components', async () => {
    const { db, bundle, first } = await shop();
    await expect(
      normaliseBundleItems(
        db,
        bundle.id,
        Array.from({ length: 21 }, (_, i) => ({
          component_product_id: `c${i}`,
          qty_milli: 1000,
        })),
      ),
    ).rejects.toMatchObject({ code: 'count' });
    const deleted = await saveNewProduct(
      db,
      { name_en: 'Gone', sku: 'GONE', price: 1 },
      await ledgerContext(db, 'st-1'),
      { now: NOW },
    );
    await db.products.update(deleted.id, { deleted_at: NOW });
    await expect(
      normaliseBundleItems(db, bundle.id, [
        { component_product_id: deleted.id, qty_milli: 1000 },
      ]),
    ).rejects.toMatchObject({ code: 'component' });
    await db.products.update(first.id, { kind: 'bundle' });
    await expect(
      normaliseBundleItems(db, bundle.id, [
        { component_product_id: first.id, qty_milli: 1000 },
      ]),
    ).rejects.toMatchObject({ code: 'component' });
  });

  it('handles a bundle with no recipe and a deleted bundle', async () => {
    const { db, ctx, bundle, first } = await shop();
    const empty = await saveNewProduct(
      db,
      {
        name_en: 'Empty Pack',
        sku: 'EMPTY-PACK',
        unit: 'set',
        price: 100,
        kind: 'bundle',
        track_stock: false,
        bundle_items: [],
      },
      ctx,
      { now: NOW },
    ).catch(() => null);
    expect(empty).toBeNull();
    await db.products.update(bundle.id, { deleted_at: NOW });
    const map = buildBundleInfoMap(
      [await db.products.get(bundle.id), first].filter(
        (row): row is MasterRow => row !== undefined,
      ),
      await db.bundle_items.where('bundle_id').equals(bundle.id).toArray(),
      new Map([[first.id, 1000]]),
    );
    expect(map.has(bundle.id)).toBe(false);
  });

  it('duplicates a bundle with a fresh recipe snapshot', async () => {
    const { db, bundle } = await shop();
    const draft = duplicateDraft(bundle);
    expect(draft.kind).toBe('bundle');
    expect(draft.track_stock).toBe(false);
    expect(draft.sku).toBe('');
    const recipe = await loadBundleRecipe(db, bundle.id);
    expect(recipe).toHaveLength(2);
  });

  it('writes bundle columns/discount and removes a returned bundle from reports', async () => {
    const { db, ctx, first, second, bundle } = await shop();
    let cart = addBundle(
      emptyCart('c1'),
      bundle,
      [
        { product: first, qty_milli: 1000 },
        { product: second, qty_milli: 1000 },
      ],
      2,
      'avg',
    );
    const group = String(cart.lines[0]?.bundle_group);
    cart = setBundleDiscount(
      cart,
      group,
      'amount',
      500,
      new Map([
        [first.id, first],
        [second.id, second],
      ]),
      'avg',
    );
    const discountedTotals = cartTotals(cart, shopMoney(null));
    expect(discountedTotals.subtotal).toBe(4000);
    expect(manualDiscountBp(cart, discountedTotals)).toBeGreaterThan(0);
    await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 4000 }], { saleId: 'sale-pack' }),
      ctx,
      NOW,
    );
    const saleRow = await db.sales.get('sale-pack');
    expect(saleRow?.bundle_discount_total).toBe(1000);
    const lines = await db.sale_lines
      .where('sale_id')
      .equals('sale-pack')
      .toArray();
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.bundle_id === bundle.id)).toBe(true);
    expect(lines.map((line) => line.bundle_qty)).toEqual([2, 2]);
    expect(lines.map((line) => line.bundle_price)).toEqual([2500, 2500]);
    expect(lines.map((line) => line.bundle_discount)).toEqual([500, 500]);
    expect(lines.map((line) => line.qty_milli)).toEqual([2000, 2000]);
    expect(
      await db.stock_movements
        .where('[ref_type+ref_id]')
        .equals(['sale', 'sale-pack'])
        .count(),
    ).toBe(2);
    let sold = await soldByProduct(db, 30, NOW);
    expect(sold.get(bundle.id)).toBe(2000);
    expect(sold.get(first.id)).toBe(2000);
    let detail = await productDetail(db, bundle.id, NOW);
    expect(detail?.last14.at(-1)?.qty).toBe(2000);
    expect(detail?.bundle?.items).toHaveLength(2);

    const refund = (id: string, qtyMilli: number, at: number) =>
      refundSale(
        db,
        {
          refundId: id,
          saleId: 'sale-pack',
          lines: lines.map((line) => ({
            saleLineId: line.id,
            qtyMilli,
            restock: true,
          })),
          reason: 'Faulty',
          method: 'cash',
          print: false,
        },
        ctx,
        at,
      );
    await refund('refund-pack-1', 1000, NOW + 1000);
    sold = await soldByProduct(db, 30, NOW + 1000);
    expect(sold.get(bundle.id)).toBe(1000);
    expect(sold.get(first.id)).toBe(1000);
    detail = await productDetail(db, bundle.id, NOW + 1000);
    expect(detail?.last14.at(-1)?.qty).toBe(1000);
    await refund('refund-pack-2', 1000, NOW + 2000);
    sold = await soldByProduct(db, 30, NOW + 2000);
    expect(sold.get(bundle.id) ?? 0).toBe(0);
    expect(sold.get(first.id) ?? 0).toBe(0);
    detail = await productDetail(db, bundle.id, NOW + 2000);
    expect(detail?.last14.at(-1)?.qty).toBe(0);
  });
});
