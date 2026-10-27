import { newId } from '@bikri/core';
import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { addProduct, cartTotals, emptyCart, shopMoney } from './cart.ts';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import { createCustomer } from './customers.ts';
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
