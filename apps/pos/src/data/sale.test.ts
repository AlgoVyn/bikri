import type { Cart } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { discardFailed } from '../sync/push.ts';
import { addOverride, addProduct, emptyCart, loadCarts } from './cart.ts';
import { createCustomer } from './customers.ts';
import {
  completeSale,
  mergeRows,
  SaleInvalidError,
  settle,
  udhaarCheck,
} from './sale.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, sale, shopWithStock, t2Cart } from './testShop.ts';

afterEach(dropTestDbs);

describe('settle (07 §4)', () => {
  it('AC 1: cash 50,000 on 43,000 gives change 7,000', () => {
    const s = settle(4300000, [{ method: 'cash', amount: 5000000 }]);
    expect(s).toMatchObject({
      applied: { cash: 4300000, card: 0, bank_wallet: 0 },
      change: 700000,
      cashTendered: 5000000,
      remaining: 0,
      valid: true,
      paidTotal: 4300000,
    });
  });

  it('short cash leaves a remainder; card/wallet/udhaar may not exceed the total; zero total is invalid', () => {
    expect(
      settle(4300000, [{ method: 'cash', amount: 4260000 }]),
    ).toMatchObject({ remaining: 40000, valid: false });
    expect(
      settle(4300000, [{ method: 'card', amount: 4400000 }]),
    ).toMatchObject({ overpaid: true, valid: false, remaining: 0 });
    expect(settle(4300000, [])).toMatchObject({
      remaining: 4300000,
      valid: false,
    });
    expect(settle(0, [])).toMatchObject({ valid: false });
    const mixed = settle(4300000, [
      { method: 'udhaar', amount: 300000 },
      { method: 'cash', amount: 4000000 },
    ]);
    expect(mixed).toMatchObject({
      udhaar: 300000,
      paidTotal: 4000000,
      valid: true,
      change: 0,
    });
  });

  it('refuses cash change when non-cash already covers the bill', () => {
    const mixed = settle(4300000, [
      { method: 'card', amount: 4300000 },
      { method: 'cash', amount: 500000 },
    ]);
    expect(mixed).toMatchObject({
      cashTendered: 500000,
      change: 0,
      remaining: 0,
      valid: false,
    });
  });

  it('merges two rows of one method and joins their references', () => {
    expect(
      mergeRows([
        {
          method: 'bank_wallet',
          amount: 100,
          provider: 'JazzCash',
          reference: 'TX1',
        },
        { method: 'cash', amount: 5 },
        {
          method: 'bank_wallet',
          amount: 50,
          provider: 'JazzCash',
          reference: 'TX2',
        },
        { method: 'bank_wallet', amount: 1, last4: '1234' },
      ]),
    ).toEqual([
      {
        method: 'bank_wallet',
        amount: 151,
        provider: 'JazzCash',
        reference: 'TX1, TX2',
        last4: '1234',
      },
      { method: 'cash', amount: 5 },
    ]);
  });
});

describe('sale recipe (02 §5)', () => {
  it('AC 1 + recipe: one transaction writes sale, lines, payment, stock; clears the cart; queues print', async () => {
    const { db, ctx, phone, buds } = await shopWithStock();
    const cart = t2Cart(phone, buds);
    await db.carts.put(cart);
    const input = sale(cart, [{ method: 'cash', amount: 5000000 }], {
      print: true,
      note: ' thanks ',
    });
    const { sale: s, created } = await completeSale(db, input, ctx, NOW);
    expect(created).toBe(true);
    expect(s).toMatchObject({
      invoice_no: 'A-A-1',
      invoice_seq: 1,
      total: 4300000,
      gross_total: 4550000,
      item_discount_total: 200000,
      bill_discount: 50000,
      bill_discount_type: 'rs',
      cash_tendered: 5000000,
      change_given: 700000,
      paid_total: 4300000,
      udhaar_amount: 0,
      line_count: 2,
      items_qty_milli: 2000,
      note: 'thanks',
      business_date: '2026-10-27',
    });
    const lines = await db.sale_lines
      .where('sale_id')
      .equals(input.saleId)
      .sortBy('line_no');
    expect(
      lines.map((l) => [
        l.line_no,
        l.name_snapshot,
        l.net,
        l.bill_discount_alloc,
        l.discount_type,
      ]),
    ).toEqual([
      [1, 'Galaxy A15', 4000000, 45977, 'rs'],
      [2, 'Earbuds', 350000, 4023, null],
    ]);
    expect(lines[0]?.warranty_until).toBe('2027-10-27');
    expect(lines[1]?.warranty_until).toBeNull();
    const pays = await db.payments.toArray();
    expect(
      pays.map((p) => [p.method, p.amount, p.cash_tendered, p.change_given]),
    ).toEqual([['cash', 4300000, 5000000, 700000]]);
    expect((await db.stock_levels.get(phone.id))?.on_hand_milli).toBe(0);
    expect((await db.stock_levels.get(buds.id))?.on_hand_milli).toBe(4000);
    const ops = await db.outbox.toArray();
    expect(new Set(ops.map((o) => o.tx_id)).size).toBe(1);
    expect(ops.map((o) => o.tbl).sort()).toEqual([
      'payments',
      'sale_lines',
      'sale_lines',
      'sales',
      'stock_movements',
      'stock_movements',
    ]);
    expect((await loadCarts(db)).c1.lines).toEqual([]);
    expect(await db.print_jobs.toArray()).toEqual([
      expect.objectContaining({
        sale_id: input.saleId,
        kind: 'sale',
        status: 'queued',
      }),
    ]);
    // Next bill takes the next number.
    const next = await completeSale(
      db,
      sale(addProduct(emptyCart('c1'), buds, 1000, 'avg'), [
        { method: 'cash', amount: 350000 },
      ]),
      ctx,
      NOW,
    );
    expect(next.sale.invoice_no).toBe('A-A-2');
  });

  it('AC 2: split cash + JazzCash writes two payments rows', async () => {
    const { db, ctx, phone, buds } = await shopWithStock();
    const input = sale(t2Cart(phone, buds), [
      { method: 'cash', amount: 3000000 },
      {
        method: 'bank_wallet',
        amount: 1300000,
        provider: 'JazzCash',
        reference: 'TX123',
      },
    ]);
    await completeSale(db, input, ctx, NOW);
    const pays = await db.payments.toArray();
    expect(
      pays.map((p) => [p.method, p.amount, p.reference, p.note]).sort(),
    ).toEqual([
      ['bank_wallet', 1300000, 'TX123', 'JazzCash'],
      ['cash', 3000000, '', ''],
    ]);
  });

  it('AC 3, 4: udhaar over a soft limit completes; a mixed bill raises the balance by the udhaar part exactly', async () => {
    const { db, ctx, phone, buds } = await shopWithStock();
    const bilal = await createCustomer(
      db,
      { name: 'Bilal', phone: null },
      'st-1',
    );
    await db.customers.update(bilal.id, { credit_limit: 4000000 });
    const cart = { ...t2Cart(phone, buds), customer_id: bilal.id };
    const check = await udhaarCheck(db, bilal.id, 4300000);
    expect(check).toMatchObject({
      balance: 0,
      limit: 4000000,
      over_limit: true,
      over_by: 300000,
      hard_blocked: false,
    });
    await completeSale(
      db,
      sale(cart, [{ method: 'udhaar', amount: 4300000 }]),
      ctx,
      NOW,
    );
    expect((await db.party_balances.get(['customer', bilal.id]))?.balance).toBe(
      4300000,
    );
    expect(await db.payments.count()).toBe(0);
    const nextCart = { ...cart, updated_at: Date.now() + 1 };
    await completeSale(
      db,
      sale(nextCart, [
        { method: 'cash', amount: 4000000 },
        { method: 'udhaar', amount: 300000 },
      ]),
      ctx,
      NOW,
    );
    expect((await db.party_balances.get(['customer', bilal.id]))?.balance).toBe(
      4600000,
    );
    const entries = await db.ledger_entries.toArray();
    expect(entries.map((e) => [e.amount, e.source_type])).toEqual([
      [4300000, 'sale'],
      [300000, 'sale'],
    ]);
    await db.customers.update(bilal.id, { hard_limit: 1 });
    expect((await udhaarCheck(db, bilal.id, 1)).hard_blocked).toBe(true);
    expect((await udhaarCheck(db, 'nobody', 1)).limit).toBeNull();
  });

  it('discards a rejected sale transaction and rebuilds its caches', async () => {
    const { db, ctx, phone, buds } = await shopWithStock('discard-sale');
    const cart = t2Cart(phone, buds);
    await db.carts.put(cart);
    await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 5000000 }]),
      ctx,
      NOW,
    );
    const ops = await db.outbox.toArray();
    const first = ops[0];
    if (first?.seq === undefined) throw new Error('no outbox op');
    await db.outbox
      .where('seq')
      .anyOf(ops.map((op) => op.seq as number))
      .modify({ status: 'failed' });
    await discardFailed(db, [first.seq]);
    expect(await db.sales.count()).toBe(0);
    expect(await db.sale_lines.count()).toBe(0);
    expect(await db.payments.count()).toBe(0);
    expect((await db.stock_levels.get(phone.id))?.on_hand_milli).toBe(1000);
    expect((await db.stock_levels.get(buds.id))?.on_hand_milli).toBe(5000);
    expect(await db.outbox.count()).toBe(0);
  });

  it('refuses a second tab selling the same cart snapshot', async () => {
    const { db, ctx, phone, buds } = await shopWithStock('cart-claim');
    const cart = t2Cart(phone, buds);
    await db.carts.put(cart);
    await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 5000000 }]),
      ctx,
      NOW,
    );
    await expect(
      completeSale(
        db,
        sale(cart, [{ method: 'cash', amount: 5000000 }]),
        ctx,
        NOW,
      ),
    ).rejects.toBeInstanceOf(SaleInvalidError);
    expect(await db.sales.count()).toBe(1);
  });

  it('AC 5: the same sale id twice writes one sale', async () => {
    const { db, ctx, buds } = await shopWithStock();
    const input = sale(addProduct(emptyCart('c1'), buds, 1000, 'avg'), [
      { method: 'cash', amount: 350000 },
    ]);
    const [a, b] = await Promise.all(
      [
        completeSale(db, input, ctx, NOW),
        completeSale(db, input, ctx, NOW),
      ].map((p) => p.catch((e) => e)),
    );
    const again = await completeSale(db, input, ctx, NOW);
    expect(again.created).toBe(false);
    expect(await db.sales.count()).toBe(1);
    expect([a, b].filter((r) => r && r.created === true)).toHaveLength(1);
  });

  it('refuses an empty cart, unpaid totals and udhaar without a customer', async () => {
    const { db, ctx, buds } = await shopWithStock();
    const cart = addProduct(emptyCart('c1'), buds, 1000, 'avg');
    await expect(
      completeSale(db, sale(emptyCart('c1'), []), ctx),
    ).rejects.toBeInstanceOf(SaleInvalidError);
    await expect(
      completeSale(db, sale(cart, [{ method: 'cash', amount: 1 }]), ctx),
    ).rejects.toThrow('payments do not cover');
    await expect(
      completeSale(db, sale(cart, [{ method: 'udhaar', amount: 350000 }]), ctx),
    ).rejects.toThrow('udhaar needs a customer');
    expect(await db.sales.count()).toBe(0);
  });

  it('quick sale lines move no stock; overrides and discounts over the limit are audited', async () => {
    const { db, ctx, buds } = await shopWithStock();
    let cart = addProduct(emptyCart('c2'), buds, 1000, 'avg');
    cart = {
      ...cart,
      bill_discount: { type: 'percent', value: 2000 },
      lines: [
        {
          ...cart.lines[0],
          key: 'q',
          product_id: null,
          name: 'Repair labour',
          unit_cost: 0,
        } as Cart['lines'][number],
        ...cart.lines,
      ],
    };
    cart = addOverride(cart, {
      permission: 'sale.discount',
      approved_by: 'st-9',
    });
    const input = sale(
      cart,
      [{ method: 'card', amount: 560000, last4: '4242' }],
      { cartId: 'c2', maxDiscountBp: 500 },
    );
    await completeSale(db, input, ctx, NOW);
    expect(
      (await db.stock_movements.toArray()).filter(
        (m) => m.reason_code === 'sale',
      ),
    ).toHaveLength(1);
    expect((await db.payments.toArray())[0]?.reference).toBe('****4242');
    const audit = await db.audit_log.toArray();
    expect(audit.map((a) => a.action)).toEqual([
      'override',
      'discount_over_limit',
    ]);
    expect(JSON.parse(String(audit[1]?.after_json))).toEqual({
      discount_share_bp: 2000,
      limit_bp: 500,
      approved_by: 'st-9',
    });
  });

  it('isolation: a sale in one shop leaves the other shop untouched; numbering is per shop', async () => {
    const a = await shopWithStock('saleA');
    const b = await shopWithStock('saleB');
    await completeSale(
      a.db,
      sale(addProduct(emptyCart('c1'), a.buds, 1000, 'avg'), [
        { method: 'cash', amount: 350000 },
      ]),
      a.ctx,
      NOW,
    );
    expect(await b.db.sales.count()).toBe(0);
    expect(await b.db.outbox.count()).toBe(0);
    expect((await b.db.stock_levels.get(b.buds.id))?.on_hand_milli).toBe(5000);
    const second = await completeSale(
      b.db,
      sale(addProduct(emptyCart('c1'), b.buds, 1000, 'avg'), [
        { method: 'cash', amount: 350000 },
      ]),
      b.ctx,
      NOW,
    );
    expect(second.sale.invoice_no).toBe('A-A-1');
  });
});
