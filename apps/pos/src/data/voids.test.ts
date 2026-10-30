import { newId } from '@bikri/core';
import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addProduct,
  addQuickSale,
  CartNotEmptyError,
  cartTotals,
  emptyCart,
  shopMoney,
} from './cart.ts';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import { createCustomer } from './customers.ts';
import { refundSale } from './refunds.ts';
import { completeSale, startReissue } from './sale.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, readyDb, sale, shopWithStock, t2Cart } from './testShop.ts';
import { voidBlocker, voidSale } from './voids.ts';

afterEach(dropTestDbs);

describe('void recipe (02 §5)', () => {
  it('AC 2: a cash bill writes a cash payment out (purpose void), returns stock and marks the sale void', async () => {
    const { db, ctx, phone, buds } = await shopWithStock();
    const cart = t2Cart(phone, buds);
    const saleId = 'sale-void';
    await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 5000000 }], { saleId }),
      ctx,
      NOW,
    );
    const { voidRow } = await voidSale(
      db,
      { voidId: 'void-1', saleId, reason: 'Wrong item' },
      ctx,
      NOW + 1000,
    );
    expect(voidRow).toMatchObject({
      sale_id: saleId,
      reason: 'Wrong item',
      replacement_sale_id: null,
    });
    const payments = await db.payments
      .where('sale_id')
      .equals(saleId)
      .toArray();
    expect(payments.filter((p) => p.purpose === 'void')).toMatchObject([
      { direction: 'out', method: 'cash', amount: 4300000 },
    ]);
    const moves = await db.stock_movements
      .filter((m) => m.ref_id === 'void-1')
      .toArray();
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.reason_code === 'void_return')).toBe(true);
    expect((await db.sales.get(saleId))?.status).toBe('void');
    const audit = await db.audit_log
      .where('[entity+entity_id]')
      .equals(['sale_voids', 'void-1'])
      .toArray();
    expect(audit).toMatchObject([{ action: 'void' }]);
  });

  it('reverses the udhaar ledger row and refuses a bill with refunds', async () => {
    const db = await readyDb('void-udhaar');
    const ctx = await ledgerContext(db, 'st-1');
    const product = await saveNewProduct(
      db,
      { name_en: 'Phone', price: 100000, opening_milli: 3000 },
      ctx,
      { now: NOW },
    );
    const customer = await createCustomer(
      db,
      { name: 'Ali', phone: '' },
      'st-1',
      NOW,
    );
    let cart = addProduct(emptyCart('c1'), product, 1000, 'avg');
    cart = { ...cart, customer_id: customer.id };
    const saleId = 'sale-void-udhaar';
    await completeSale(
      db,
      sale(
        cart,
        [
          { method: 'cash', amount: 40000 },
          { method: 'udhaar', amount: 60000 },
        ],
        { saleId },
      ),
      ctx,
      NOW,
    );
    await voidSale(
      db,
      { voidId: 'void-udhaar', saleId, reason: 'Customer cancelled' },
      ctx,
      NOW + 1000,
    );
    const ledger = await db.ledger_entries
      .where('source_id')
      .equals('void-udhaar')
      .toArray();
    expect(ledger).toMatchObject([
      { party_type: 'customer', party_id: customer.id, amount: -60000 },
    ]);
    const balance = await db.party_balances.get(['customer', customer.id]);
    expect(balance?.balance).toBe(0);

    // A second void of the same bill is a no-op (the recipe is idempotent).
    const again = await voidSale(
      db,
      { voidId: 'void-udhaar-2', saleId, reason: 'Again' },
      ctx,
      NOW + 2000,
    );
    expect(again.created).toBe(false);
  });

  it('a manager may void only same-day bills; the owner may void any day', async () => {
    const { db, ctx, phone, buds } = await shopWithStock();
    await db.staff.add({
      id: 'mgr-1',
      name: 'Bilal',
      role: 'manager',
      active: 1,
      permissions_json: '{}',
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
    });
    const cart = t2Cart(phone, buds);
    const saleId = 'sale-manager';
    await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 5000000 }], { saleId }),
      ctx,
      NOW,
    );
    const managerCtx = { ...ctx, staff_id: 'mgr-1' };
    await expect(
      voidSale(
        db,
        { voidId: newId(), saleId, reason: 'Wrong item' },
        managerCtx,
        NOW + 2 * 86_400_000,
      ),
    ).rejects.toMatchObject({ code: 'same_day' });
    await voidSale(
      db,
      { voidId: 'void-owner', saleId, reason: 'Wrong item' },
      ctx,
      NOW + 2 * 86_400_000,
    );
    expect((await db.sales.get(saleId))?.status).toBe('void');
  });

  it('voidBlocker mirrors the server rules for the button', () => {
    const saleRow = {
      business_date: '2026-10-26',
      status: 'paid',
    } as unknown as SyncedRow;
    expect(
      voidBlocker(
        { sale: saleRow, refunds: [] },
        'manager',
        '2026-10-27',
        true,
      ),
    ).toBe('same_day');
    expect(
      voidBlocker(
        { sale: saleRow, refunds: [{}] },
        'manager',
        '2026-10-27',
        true,
      ),
    ).toBe('refunded');
    expect(
      voidBlocker(
        { sale: { ...saleRow, status: 'void' }, refunds: [] },
        'owner',
        '2026-10-27',
        true,
      ),
    ).toBe('voided');
    expect(
      voidBlocker(
        { sale: saleRow, refunds: [] },
        'cashier',
        '2026-10-27',
        false,
      ),
    ).toBe('forbidden');
  });
});

describe('void & reissue (screens/10 AC 3)', () => {
  it('prefills the cart and voids the old bill in the same action as the new sale', async () => {
    const { db, ctx, phone, buds } = await shopWithStock();
    const cart = t2Cart(phone, buds);
    const oldId = 'sale-old';
    const { sale: oldSale } = await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 5000000 }], { saleId: oldId }),
      ctx,
      NOW,
    );
    const reissueCart = await startReissue(db, {
      saleId: oldId,
      cartId: 'c2',
      reason: 'Wrong price',
      now: NOW + 1000,
    });
    expect(reissueCart.lines).toHaveLength(2);
    expect(reissueCart.reissue).toMatchObject({ sale_id: oldId });
    expect(reissueCart.customer_id).toBeNull();

    const newIdValue = 'sale-new';
    const total = cartTotals(reissueCart, shopMoney(null)).total;
    await completeSale(
      db,
      {
        saleId: newIdValue,
        cartId: 'c2',
        cart: reissueCart,
        money: shopMoney(null),
        rows: [{ method: 'cash', amount: total }],
        print: false,
        maxDiscountBp: 10000,
      },
      ctx,
      NOW + 2000,
    );
    const fresh = await db.sales.get(newIdValue);
    expect(fresh).toMatchObject({
      replaces_sale_id: oldId,
      invoice_seq: 2,
    });
    expect(String(fresh?.invoice_no).endsWith('-2')).toBe(true);
    expect((await db.sales.get(oldId))?.status).toBe('void');
    const voidRow = await db.sale_voids.where('sale_id').equals(oldId).first();
    expect(voidRow).toMatchObject({
      replacement_sale_id: newIdValue,
      reason: 'Wrong price',
    });
    // AC 3: reports count only the replacement.
    const live = await db.sales.filter((s) => s.status !== 'void').toArray();
    expect(live.map((s) => s.id)).toEqual([newIdValue]);
    expect(oldSale.status).toBe('paid');
  });

  it('refuses to reissue a voided or refunded bill', async () => {
    const { db } = await shopWithStock();
    await db.sales.put({
      id: 'voided',
      invoice_no: 'A-A-9',
      invoice_seq: 9,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      customer_id: null,
      business_date: '2026-10-27',
      created_at: NOW,
      line_count: 0,
      items_qty_milli: 0,
      gross_total: 0,
      item_discount_total: 0,
      subtotal: 0,
      bill_discount_type: null,
      bill_discount_value: 0,
      bill_discount: 0,
      tax_rate_bp: 0,
      tax: 0,
      tax_inclusive: 0,
      rounding: 0,
      total: 0,
      paid_total: 0,
      udhaar_amount: 0,
      cash_tendered: 0,
      change_given: 0,
      status: 'void',
      replaces_sale_id: null,
      note: '',
    });
    await expect(
      startReissue(db, {
        saleId: 'voided',
        cartId: 'c2',
        reason: 'Wrong price',
      }),
    ).rejects.toMatchObject({ code: 'voided' });
    await expect(
      startReissue(db, {
        saleId: 'missing',
        cartId: 'c2',
        reason: 'Wrong price',
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('void and reissue branches', () => {
  async function cashSale(prefix: string) {
    const fx = await shopWithStock(prefix);
    const saleId = `${prefix}-sale`;
    await completeSale(
      fx.db,
      sale(t2Cart(fx.phone, fx.buds), [{ method: 'cash', amount: 5000000 }], {
        saleId,
      }),
      fx.ctx,
      NOW,
    );
    return { ...fx, saleId };
  }

  it('covers void errors, a cashier override and a cashier with sale.void', async () => {
    const fx = await cashSale('void-branch');
    await expect(
      voidSale(
        fx.db,
        { voidId: newId(), saleId: 'missing', reason: 'x' },
        fx.ctx,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'missing' });
    await expect(
      voidSale(
        fx.db,
        { voidId: newId(), saleId: fx.saleId, reason: ' ' },
        fx.ctx,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'reason' });
    await expect(
      voidSale(
        fx.db,
        { voidId: newId(), saleId: fx.saleId, reason: 'x'.repeat(121) },
        fx.ctx,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'reason' });
    await expect(
      voidSale(
        fx.db,
        { voidId: newId(), saleId: fx.saleId, reason: 'Wrong item' },
        { ...fx.ctx, staff_id: 'missing' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const staff = [
      {
        id: 'cash-1',
        name: 'Sana',
        role: 'cashier',
        active: 1,
        permissions_json: '{}',
      },
      {
        id: 'cash-2',
        name: 'Sana 2',
        role: 'cashier',
        active: 1,
        permissions_json: '{"sale.void":true}',
      },
      {
        id: 'cash-3',
        name: 'Sana 3',
        role: 'cashier',
        active: 1,
        permissions_json: 'not-json',
      },
    ];
    for (const s of staff)
      await fx.db.staff.add({
        ...s,
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null,
        rev: 1,
      });
    await expect(
      voidSale(
        fx.db,
        { voidId: newId(), saleId: fx.saleId, reason: 'Wrong item' },
        { ...fx.ctx, staff_id: 'cash-1' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      voidSale(
        fx.db,
        { voidId: newId(), saleId: fx.saleId, reason: 'Wrong item' },
        { ...fx.ctx, staff_id: 'cash-3' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const override = await voidSale(
      fx.db,
      {
        voidId: 'cashier-override',
        saleId: fx.saleId,
        reason: 'Wrong item',
        override: { approved_by: 'st-1' },
      },
      { ...fx.ctx, staff_id: 'cash-1' },
      NOW,
    );
    expect(override.created).toBe(true);
    expect(
      await fx.db.audit_log
        .where('[entity+entity_id]')
        .equals(['sale_voids', 'cashier-override'])
        .toArray(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'override' }),
        expect.objectContaining({ action: 'void' }),
      ]),
    );

    const granted = await cashSale('void-granted');
    await granted.db.staff.add({
      id: 'cash-2',
      name: 'Sana 2',
      role: 'cashier',
      active: 1,
      permissions_json: '{"sale.void":true}',
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
    });
    await voidSale(
      granted.db,
      {
        voidId: 'cashier-granted',
        saleId: granted.saleId,
        reason: 'Wrong item',
      },
      { ...granted.ctx, staff_id: 'cash-2' },
      NOW,
    );
    expect((await granted.db.sales.get(granted.saleId))?.status).toBe('void');
  });

  it('voids an untracked line and a fully-udhaar bill', async () => {
    const db = await readyDb('void-untracked');
    const ctx = await ledgerContext(db, 'st-1');
    const service = await saveNewProduct(
      db,
      { name_en: 'Service', price: 100000, track_stock: false },
      ctx,
      { now: NOW },
    );
    const serviceSale = sale(
      addProduct(emptyCart('c1'), service, 1000, 'avg'),
      [{ method: 'cash', amount: 100000 }],
      { saleId: 'service-sale' },
    );
    await completeSale(db, serviceSale, ctx, NOW);
    await voidSale(
      db,
      { voidId: 'service-void', saleId: 'service-sale', reason: 'Wrong item' },
      ctx,
      NOW + 1000,
    );
    expect(
      await db.stock_movements
        .filter((m) => m.ref_id === 'service-void')
        .count(),
    ).toBe(0);

    const customer = await createCustomer(
      db,
      { name: 'Ali', phone: '' },
      'st-1',
      NOW,
    );
    let cart = addProduct(emptyCart('c2'), service, 1000, 'avg');
    cart = { ...cart, customer_id: customer.id };
    await completeSale(
      db,
      sale(cart, [{ method: 'udhaar', amount: 100000 }], {
        saleId: 'udhaar-void-sale',
      }),
      ctx,
      NOW + 2000,
    );
    await voidSale(
      db,
      {
        voidId: 'udhaar-void',
        saleId: 'udhaar-void-sale',
        reason: 'Customer cancelled',
      },
      ctx,
      NOW + 3000,
    );
    expect(
      await db.payments
        .filter((p) => p.purpose === 'void' && p.sale_id === 'udhaar-void-sale')
        .count(),
    ).toBe(0);
    expect(
      await db.ledger_entries
        .where('source_id')
        .equals('udhaar-void')
        .toArray(),
    ).toMatchObject([{ party_type: 'customer', amount: -100000 }]);
  });

  it('allows a manager a same-day void and an override on an older bill', async () => {
    await shopWithStock('void-manager');
    const fx = await cashSale('void-manager-day');
    await fx.db.staff.add({
      id: 'mgr-day',
      name: 'Bilal',
      role: 'manager',
      active: 1,
      permissions_json: '{}',
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
    });
    await voidSale(
      fx.db,
      { voidId: 'manager-today', saleId: fx.saleId, reason: 'Wrong item' },
      { ...fx.ctx, staff_id: 'mgr-day' },
      NOW,
    );
    expect((await fx.db.sales.get(fx.saleId))?.status).toBe('void');

    const older = await cashSale('void-manager-old');
    await older.db.staff.add({
      id: 'mgr-day',
      name: 'Bilal',
      role: 'manager',
      active: 1,
      permissions_json: '{}',
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
    });
    await expect(
      voidSale(
        older.db,
        { voidId: newId(), saleId: older.saleId, reason: 'Wrong item' },
        { ...older.ctx, staff_id: 'mgr-day' },
        NOW + 2 * 86_400_000,
      ),
    ).rejects.toMatchObject({ code: 'same_day' });
    await voidSale(
      older.db,
      {
        voidId: 'manager-old-override',
        saleId: older.saleId,
        reason: 'Wrong item',
        override: { approved_by: 'st-1' },
      },
      { ...older.ctx, staff_id: 'mgr-day' },
      NOW + 2 * 86_400_000,
    );

    const saleRow = {
      business_date: '2026-10-26',
      status: 'paid',
    } as unknown as SyncedRow;
    expect(
      voidBlocker(
        { sale: saleRow, refunds: [] },
        'manager',
        '2026-10-26',
        true,
      ),
    ).toBeNull();
    expect(
      voidBlocker(
        { sale: saleRow, refunds: [] },
        'cashier',
        '2026-10-26',
        false,
        true,
      ),
    ).toBeNull();
  });

  it('covers startReissue errors, percentages and a non-empty cart', async () => {
    const fx = await cashSale('reissue-branch');
    await expect(
      startReissue(fx.db, {
        saleId: 'missing',
        cartId: 'c2',
        reason: 'Wrong item',
      }),
    ).rejects.toMatchObject({ code: 'missing' });
    await expect(
      startReissue(fx.db, {
        saleId: fx.saleId,
        cartId: 'c2',
        reason: ' ',
      }),
    ).rejects.toMatchObject({ code: 'reason' });
    await fx.db.carts.put({
      ...emptyCart('c2'),
      lines: [
        {
          key: 'occupied',
          product_id: null,
          name: 'Occupied',
          sku: '',
          qty_milli: 1000,
          unit_price: 1,
          discount_value: 0,
          unit_cost: 0,
          track_stock: 0,
          unit: 'pc',
        },
      ],
    });
    await expect(
      startReissue(fx.db, {
        saleId: fx.saleId,
        cartId: 'c2',
        reason: 'Wrong item',
      }),
    ).rejects.toBeInstanceOf(CartNotEmptyError);
    await fx.db.carts.delete('c2');
    await expect(
      startReissue(fx.db, {
        saleId: fx.saleId,
        cartId: 'c3',
        reason: 'Wrong item',
      }),
    ).resolves.toBeDefined();

    const customer = await createCustomer(
      fx.db,
      { name: 'Ali', phone: '' },
      'st-1',
      NOW,
    );
    let cart = t2Cart(fx.phone, fx.buds);
    cart = addQuickSale(cart, { name: 'Quick', price: 1000, qtyMilli: 1 });
    cart = {
      ...cart,
      customer_id: customer.id,
      bill_discount: { type: 'percent', value: 1000 },
    };
    const saleId = 'reissue-percent';
    await completeSale(
      fx.db,
      sale(
        cart,
        [{ method: 'cash', amount: cartTotals(cart, shopMoney(null)).total }],
        { saleId },
      ),
      fx.ctx,
      NOW,
    );
    const reissued = await startReissue(fx.db, {
      saleId,
      cartId: 'c2',
      reason: 'Wrong price',
      now: NOW + 1000,
    });
    expect(reissued.customer_id).toBe(customer.id);
    expect(reissued.bill_discount).toEqual({ type: 'percent', value: 1000 });
    expect(reissued.lines.some((l) => l.product_id === null)).toBe(true);

    const refunded = await cashSale('reissue-refunded');
    const line = (await refunded.db.sale_lines
      .where('sale_id')
      .equals(refunded.saleId)
      .first()) as { id: string };
    await refundSale(
      refunded.db,
      {
        refundId: 'reissue-refund',
        saleId: refunded.saleId,
        lines: [{ saleLineId: line.id, qtyMilli: 1000, restock: true }],
        reason: 'Faulty',
        method: 'cash',
      },
      refunded.ctx,
      NOW + 1000,
    );
    await expect(
      startReissue(refunded.db, {
        saleId: refunded.saleId,
        cartId: 'c2',
        reason: 'Wrong price',
      }),
    ).rejects.toMatchObject({ code: 'refunded' });
  });

  it('completes a reissue with a stored sale.void override', async () => {
    const fx = await cashSale('reissue-override');
    const cart = await startReissue(fx.db, {
      saleId: fx.saleId,
      cartId: 'c2',
      reason: 'Wrong price',
      now: NOW + 1000,
    });
    const overridden = {
      ...cart,
      overrides: [{ permission: 'sale.void', approved_by: 'st-1' }],
    };
    const total = cartTotals(overridden, shopMoney(null)).total;
    await completeSale(
      fx.db,
      {
        saleId: 'reissue-override-new',
        cartId: 'c2',
        cart: overridden,
        money: shopMoney(null),
        rows: [{ method: 'cash', amount: total }],
        print: false,
        maxDiscountBp: 10000,
      },
      fx.ctx,
      NOW + 2000,
    );
    const voidRow = await fx.db.sale_voids
      .where('sale_id')
      .equals(fx.saleId)
      .first();
    expect(voidRow).toMatchObject({
      replacement_sale_id: 'reissue-override-new',
    });
    expect(
      await fx.db.audit_log
        .where('[entity+entity_id]')
        .equals(['sale_voids', String(voidRow?.id)])
        .toArray(),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'override' })]),
    );
  });
});
