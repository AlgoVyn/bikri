import type { Cart, MasterRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addOverride,
  addProduct,
  addQuickSale,
  approversFor,
  CartFullError,
  CartNotEmptyError,
  cartTotals,
  deleteHeld,
  emptyCart,
  findByCode,
  HELD_EXPIRY_MS,
  heldExpiringCount,
  holdCart,
  isEmptyCart,
  lineGross,
  listHeld,
  loadCarts,
  MAX_CART_LINES,
  parseQtyPrefix,
  paymentChecks,
  removeLine,
  resumeHeld,
  saveCart,
  shopMoney,
  updateLine,
} from './cart.ts';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import { attentionItems } from './home.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const product = (id: string, price: number, extra: Partial<MasterRow> = {}) =>
  ({
    id,
    name_en: `P ${id}`,
    sku: `SKU-${id}`,
    price,
    avg_cost: 0,
    last_cost: 0,
    track_stock: 1,
    unit: 'pc',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    rev: 1,
    ...extra,
  }) as MasterRow;

const money = shopMoney(null);

describe('cart lines (screens/05)', () => {
  it('AC 1: the same product three times is one line with qty 3', () => {
    let cart = emptyCart('c1', NOW);
    const p = product('a', 50000);
    for (let i = 0; i < 3; i += 1) cart = addProduct(cart, p, 1000, 'avg');
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.qty_milli).toBe(3000);
  });

  it('a line with a note or a price override does not merge; newest on top', () => {
    let cart = addProduct(emptyCart('c1'), product('a', 50000), 1000, 'avg');
    const key = cart.lines[0]?.key ?? '';
    cart = updateLine(cart, key, { note: 'IMEI 1'.padEnd(80, 'x') });
    expect(cart.lines[0]?.note).toHaveLength(60);
    cart = addProduct(cart, product('a', 50000), 1000, 'avg');
    expect(cart.lines).toHaveLength(2);
    const second = cart.lines[0]?.key ?? '';
    cart = updateLine(cart, second, { unit_price: 45000 });
    cart = addProduct(cart, product('a', 50000), 1000, 'avg');
    expect(cart.lines).toHaveLength(3);
    cart = addProduct(cart, product('b', 100), 1000, 'avg');
    expect(cart.lines[0]?.product_id).toBe('b');
  });

  it('uses last cost when the shop costs by last purchase; falls back to the other cost', () => {
    const p = product('a', 100, { avg_cost: 70, last_cost: 80 });
    expect(
      addProduct(emptyCart('c1'), p, 1000, 'avg').lines[0]?.unit_cost,
    ).toBe(70);
    expect(
      addProduct(emptyCart('c1'), p, 1000, 'last').lines[0]?.unit_cost,
    ).toBe(80);
    const onlyLast = product('b', 100, {
      avg_cost: 0,
      last_cost: 60,
      image_key: 'products/b/x.webp',
      track_stock: 0,
    });
    const line = addProduct(emptyCart('c1'), onlyLast, 1000, 'avg').lines[0];
    expect(line).toMatchObject({
      unit_cost: 60,
      image_key: 'products/b/x.webp',
      track_stock: 0,
    });
  });

  it('quantity 0 removes a line; remove drops it', () => {
    let cart = addProduct(emptyCart('c1'), product('a', 100), 1000, 'avg');
    cart = addProduct(cart, product('b', 100), 1000, 'avg');
    cart = updateLine(cart, cart.lines[0]?.key ?? '', { qty_milli: 0 });
    expect(cart.lines.map((l) => l.product_id)).toEqual(['a']);
    cart = removeLine(cart, cart.lines[0]?.key ?? '');
    expect(cart.lines).toEqual([]);
  });

  it(`a bill has at most ${MAX_CART_LINES} lines`, () => {
    let cart = emptyCart('c1');
    for (let i = 0; i < MAX_CART_LINES; i += 1)
      cart = addProduct(cart, product(`p${i}`, 100), 1000, 'avg');
    expect(() => addProduct(cart, product('x', 100), 1000, 'avg')).toThrow(
      CartFullError,
    );
    expect(() =>
      addQuickSale(cart, { name: 'x', price: 1, qtyMilli: 1000 }),
    ).toThrow(CartFullError);
    // Adding more of an existing line still works.
    expect(
      addProduct(cart, product('p0', 100), 1000, 'avg').lines,
    ).toHaveLength(MAX_CART_LINES);
  });

  it('AC 8: quick sale has no product and cost 0; blank description is "Item"', () => {
    const cart = addQuickSale(emptyCart('c1'), {
      name: ' ',
      price: 50000,
      qtyMilli: 1000,
    });
    expect(cart.lines[0]).toMatchObject({
      product_id: null,
      name: 'Item',
      unit_cost: 0,
      track_stock: 0,
    });
  });

  it('3* sets the quantity of the next add', () => {
    expect(parseQtyPrefix('3*')).toEqual({ qtyMilli: 3000, rest: '' });
    expect(parseQtyPrefix(' 1.5 * 8964')).toEqual({
      qtyMilli: 1500,
      rest: '8964',
    });
    expect(parseQtyPrefix('0*')).toBeNull();
    expect(parseQtyPrefix('cable')).toBeNull();
  });
});

describe('totals and payment checks (07 §3)', () => {
  it('AC 3: vector T2', () => {
    let cart = emptyCart('c1');
    cart = addProduct(cart, product('phone', 4200000), 1000, 'avg');
    cart = updateLine(cart, cart.lines[0]?.key ?? '', {
      discount_type: 'amount',
      discount_value: 200000,
    });
    cart = addProduct(cart, product('buds', 350000), 1000, 'avg');
    cart = { ...cart, bill_discount: { type: 'amount', value: 50000 } };
    const t = cartTotals(cart, money);
    expect([
      t.gross_total,
      t.item_discount_total,
      t.bill_discount,
      t.total,
    ]).toEqual([4550000, 200000, 50000, 4300000]);
  });

  it('percent discounts, tax and rounding follow the shop', () => {
    let cart = addProduct(emptyCart('c1'), product('a', 1000000), 1000, 'avg');
    cart = { ...cart, bill_discount: { type: 'percent', value: 1000 } };
    const t4 = cartTotals(
      cart,
      shopMoney({
        tax_rate_bp: 1700,
        tax_mode: 'exclusive',
        round_total_to: 100,
      } as unknown as MasterRow),
    );
    expect(t4.total).toBe(1053000);
    cart = updateLine(cart, cart.lines[0]?.key ?? '', {
      discount_type: 'percent',
      discount_value: 500,
    });
    const shop = shopMoney({
      tax_rate_bp: 1700,
      tax_mode: 'inclusive',
      round_total_to: 1,
      cost_method: 'last',
      show_cost_on_till: 1,
      tax_label: 'GST',
    } as unknown as MasterRow);
    expect(shop).toMatchObject({
      tax_mode: 'inclusive',
      cost_method: 'last',
      show_cost_on_till: true,
      tax_label: 'GST',
    });
    expect(cartTotals(cart, shop).item_discount_total).toBe(50000);
    expect(
      lineGross({
        ...cart.lines[0],
        qty_milli: 1250,
        unit_price: 12000,
      } as never),
    ).toBe(15000);
  });

  it('AC 4: below cost needs sale.below_cost or an override; discount over the limit needs an override', () => {
    let cart = addProduct(
      emptyCart('c1'),
      product('a', 90000, { avg_cost: 100000 }),
      1000,
      'avg',
    );
    const cashier = {
      maxDiscountBp: 500,
      canBelowCost: false,
      canDiscount: true,
    };
    expect(paymentChecks(cart, cartTotals(cart, money), cashier)).toEqual({
      belowCost: true,
      discount: false,
    });
    expect(
      paymentChecks(cart, cartTotals(cart, money), {
        ...cashier,
        canBelowCost: true,
      }).belowCost,
    ).toBe(false);
    cart = addOverride(cart, {
      permission: 'sale.below_cost',
      approved_by: 'st-2',
    });
    cart = addOverride(cart, {
      permission: 'sale.below_cost',
      approved_by: 'st-3',
    });
    expect(cart.overrides).toHaveLength(1);
    expect(
      paymentChecks(cart, cartTotals(cart, money), cashier).belowCost,
    ).toBe(false);
    cart = { ...cart, bill_discount: { type: 'percent', value: 1000 } };
    expect(paymentChecks(cart, cartTotals(cart, money), cashier).discount).toBe(
      true,
    );
    expect(
      paymentChecks(cart, cartTotals(cart, money), {
        ...cashier,
        maxDiscountBp: 1000,
      }).discount,
    ).toBe(false);
    expect(
      paymentChecks(cart, cartTotals(cart, money), {
        ...cashier,
        maxDiscountBp: 10000,
        canDiscount: false,
      }).discount,
    ).toBe(true);
    cart = addOverride(cart, {
      permission: 'sale.discount',
      approved_by: 'st-2',
    });
    expect(paymentChecks(cart, cartTotals(cart, money), cashier).discount).toBe(
      false,
    );
  });

  it('approvers are active staff with a PIN who hold the permission', () => {
    const staff = [
      { id: 'a', active: 1, pin_hash: 'h', role: 'manager' },
      { id: 'b', active: 1, pin_hash: '', role: 'owner' },
      { id: 'c', active: 0, pin_hash: 'h', role: 'owner' },
      { id: 'd', active: 1, pin_hash: 'h', role: 'cashier' },
      { id: 'e', active: 1, pin_hash: 'h', role: 'owner', deleted_at: 5 },
    ] as unknown as MasterRow[];
    expect(
      approversFor(staff, (s) => s.role !== 'cashier').map((s) => s.id),
    ).toEqual(['a']);
  });
});

describe('carts, codes and held bills in Dexie', () => {
  it('AC 5: three carts persist independently', async () => {
    const db = await readyDb('cart');
    const empty = await loadCarts(db);
    expect(Object.values(empty).every(isEmptyCart)).toBe(true);
    for (const id of ['c1', 'c2', 'c3'] as const)
      await saveCart(
        db,
        addProduct(emptyCart(id), product(id, 100), 1000, 'avg'),
        NOW,
      );
    const carts = await loadCarts(db);
    expect(carts.c1.lines[0]?.product_id).toBe('c1');
    expect(carts.c3.lines[0]?.product_id).toBe('c3');
    expect(carts.c2.updated_at).toBe(NOW);
  });

  it('finds products by barcode or SKU, never deleted ones', async () => {
    const db = await readyDb('cart');
    const ctx = await ledgerContext(db, 'st-1');
    const p = await saveNewProduct(
      db,
      { name_en: 'Cable', price: 100, sku: 'CAB-9', barcodes: ['8964000111'] },
      ctx,
    );
    expect((await findByCode(db, ' 8964000111 '))?.id).toBe(p.id);
    expect((await findByCode(db, 'CAB-9'))?.id).toBe(p.id);
    expect(await findByCode(db, '')).toBeNull();
    expect(await findByCode(db, '000')).toBeNull();
    await db.product_barcodes.toCollection().modify({ deleted_at: NOW });
    expect(await findByCode(db, '8964000111')).toBeNull();
  });

  it('AC 6: hold then resume restores lines, discounts and customer exactly', async () => {
    const db = await readyDb('cart');
    let cart = addProduct(emptyCart('c2'), product('a', 4200000), 1000, 'avg');
    cart = updateLine(cart, cart.lines[0]?.key ?? '', {
      discount_type: 'amount',
      discount_value: 200000,
      note: 'IMEI 35',
    });
    cart = {
      ...cart,
      customer_id: 'cu-1',
      bill_discount: { type: 'amount', value: 50000 },
    };
    await saveCart(db, cart, NOW);
    const held = await holdCart(db, cart, {
      label: ' Bilal ',
      staffId: 'st-1',
      now: NOW,
    });
    expect(held.label).toBe('Bilal');
    expect(isEmptyCart((await loadCarts(db)).c2)).toBe(true);
    expect((await listHeld(db, NOW)).map((h) => h.id)).toEqual([held.id]);
    // Resume into a non-empty tab is refused.
    await saveCart(
      db,
      addProduct(emptyCart('c1'), product('z', 1), 1000, 'avg'),
    );
    await expect(resumeHeld(db, held.id, 'c1')).rejects.toBeInstanceOf(
      CartNotEmptyError,
    );
    const back = await resumeHeld(db, held.id, 'c3', NOW + 1);
    const { updated_at: _u, id: _i, ...want } = cart;
    const { updated_at: _u2, id, ...got } = back;
    expect(id).toBe('c3');
    expect(got).toEqual(want);
    expect(await db.held_bills.count()).toBe(0);
    await expect(resumeHeld(db, held.id, 'c3')).rejects.toThrow(
      'Held bill not found',
    );
  });

  it('held bills expire after 7 days; delete removes one', async () => {
    const db = await readyDb('cart');
    const cart = addProduct(emptyCart('c1'), product('a', 100), 1000, 'avg');
    const old = await holdCart(db, cart, {
      label: 'old',
      staffId: 'st-1',
      now: NOW - HELD_EXPIRY_MS - 1,
    });
    await holdCart(db, cart, {
      label: 'aging',
      staffId: 'st-1',
      now: NOW - HELD_EXPIRY_MS + 1000,
    });
    const fresh = await holdCart(db, cart, {
      label: 'new',
      staffId: 'st-1',
      now: NOW,
    });
    expect(await heldExpiringCount(db, NOW)).toBe(2);
    const items = await attentionItems(db, {
      today: '2026-10-27',
      yesterday: '2026-10-26',
      deviceId: 'dev-1',
      isOwner: false,
      now: NOW,
    });
    expect(items).toContainEqual({ kind: 'held_expiring', count: 2 });
    expect((await listHeld(db, NOW)).map((h) => h.label)).toEqual([
      'new',
      'aging',
    ]);
    expect(await db.held_bills.get(old.id)).toBeUndefined();
    await deleteHeld(db, fresh.id);
    expect((await listHeld(db, NOW)).map((h) => h.label)).toEqual(['aging']);
  });

  it('isolation: carts and held bills of one shop are invisible to another', async () => {
    const a = await readyDb('cartA');
    const b = await readyDb('cartB');
    const cart: Cart = addProduct(
      emptyCart('c1'),
      product('a', 100),
      1000,
      'avg',
    );
    await saveCart(a, cart);
    await holdCart(a, cart, { label: 'x', staffId: 'st-1' });
    expect(isEmptyCart((await loadCarts(b)).c1)).toBe(true);
    expect(await listHeld(b)).toEqual([]);
    expect(await findByCode(b, 'SKU-a')).toBeNull();
  });
});
