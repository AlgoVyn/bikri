import { afterEach, describe, expect, it } from 'vitest';
import { jobReceipt } from '../print/receiptFiles.ts';
import { addProduct, addQuickSale, emptyCart } from './cart.ts';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import { createCustomer } from './customers.ts';
import { computeRefund, RefundNotAllowedError, refundSale } from './refunds.ts';
import { completeSale } from './sale.ts';
import { dropTestDbs } from './testDb.ts';
import {
  addShop,
  NOW,
  readyDb,
  sale,
  shopWithStock,
  t2Cart,
} from './testShop.ts';

afterEach(dropTestDbs);

async function t1Sale() {
  const db = await readyDb('refund-t1');
  const ctx = await ledgerContext(db, 'st-1');
  const cable = await saveNewProduct(
    db,
    { name_en: 'Cable', price: 45000, cost: 30000, opening_milli: 10000 },
    ctx,
    { now: NOW },
  );
  const charger = await saveNewProduct(
    db,
    { name_en: 'Charger', price: 125000, cost: 90000, opening_milli: 5000 },
    ctx,
    { now: NOW },
  );
  const customer = await createCustomer(
    db,
    { name: 'Ali', phone: '+923001234567' },
    'st-1',
    NOW,
  );
  let cart = addProduct(emptyCart('c1'), cable, 2000, 'avg');
  cart = addProduct(cart, charger, 1000, 'avg');
  cart = { ...cart, customer_id: customer.id };
  const saleId = 'sale-t1';
  const { sale: row } = await completeSale(
    db,
    sale(
      cart,
      [
        { method: 'cash', amount: 100000 },
        { method: 'udhaar', amount: 115000 },
      ],
      { saleId },
    ),
    ctx,
    NOW,
  );
  const lines = await db.sale_lines
    .where('sale_id')
    .equals(saleId)
    .sortBy('line_no');
  return { db, ctx, saleId, row, lines, customerId: customer.id };
}

describe('refund plan and split (07 §6)', () => {
  it('R1: the earbuds of T2 refund for 345,977 exact, 346,000 cash (+23)', async () => {
    const { db, ctx, phone, buds } = await shopWithStock();
    const cart = t2Cart(phone, buds);
    const saleId = 'sale-r1';
    await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 5000000 }], { saleId }),
      ctx,
      NOW,
    );
    const budsLine = (
      await db.sale_lines.where('sale_id').equals(saleId).toArray()
    ).find((l) => l.name_snapshot === 'Earbuds');
    expect(budsLine).toBeDefined();
    const plan = await computeRefund(
      db,
      saleId,
      [{ saleLineId: budsLine?.id ?? '', qtyMilli: 1000, restock: true }],
      'cash',
    );
    expect(plan).toMatchObject({
      exact: 345977,
      udhaarPart: 0,
      paidExact: 345977,
      method: 'cash',
      amount: 346000,
      rounding: 23,
    });
  });

  it('R4: three single-unit refunds add up to exactly the line final', async () => {
    const db = await readyDb('refund-r4');
    const ctx = await ledgerContext(db, 'st-1');
    const product = await saveNewProduct(
      db,
      { name_en: 'Adapter', price: 142400, opening_milli: 3000 },
      ctx,
      { now: NOW },
    );
    const cart = addProduct(emptyCart('c1'), product, 3000, 'avg');
    const saleId = 'sale-r4';
    await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 427200 }], { saleId }),
      ctx,
      NOW,
    );
    const line = (await db.sale_lines
      .where('sale_id')
      .equals(saleId)
      .first()) as { id: string };
    let total = 0;
    for (let i = 0; i < 3; i += 1) {
      const plan = await computeRefund(
        db,
        saleId,
        [{ saleLineId: line.id, qtyMilli: 1000, restock: true }],
        'card',
      );
      total += plan.exact;
    }
    expect(total).toBe(427200);
  });

  it('R5/R6: the paid part comes first, then the khata (method NULL, no payment)', async () => {
    const { db, ctx, saleId, lines, row } = await t1Sale();
    expect(row).toMatchObject({ paid_total: 100000, udhaar_amount: 115000 });
    const cable = lines[0];
    const charger = lines[1];
    expect(cable).toBeDefined();
    expect(charger).toBeDefined();

    const first = await computeRefund(
      db,
      saleId,
      [{ saleLineId: charger?.id ?? '', qtyMilli: 1000, restock: true }],
      'cash',
    );
    expect(first).toMatchObject({
      exact: 125000,
      udhaarPart: 25000,
      paidExact: 100000,
      amount: 100000,
      rounding: 0,
      method: 'cash',
    });

    await refundSale(
      db,
      {
        refundId: 'refund-r5',
        saleId,
        lines: [
          { saleLineId: charger?.id ?? '', qtyMilli: 1000, restock: true },
        ],
        reason: 'Faulty',
        method: 'cash',
      },
      ctx,
      NOW + 1000,
    );

    const second = await computeRefund(
      db,
      saleId,
      [{ saleLineId: cable?.id ?? '', qtyMilli: 1000, restock: true }],
      'cash',
    );
    expect(second).toMatchObject({
      exact: 45000,
      udhaarPart: 45000,
      paidExact: 0,
      amount: 0,
      rounding: 0,
      method: null,
    });

    const refund = await refundSale(
      db,
      {
        refundId: 'refund-r6',
        saleId,
        lines: [{ saleLineId: cable?.id ?? '', qtyMilli: 1000, restock: true }],
        reason: 'Changed mind',
        method: 'cash',
      },
      ctx,
      NOW + 2000,
    );
    expect(refund.refund).toMatchObject({
      exact_amount: 45000,
      udhaar_part: 45000,
      amount: 0,
      method: null,
      rounding: 0,
    });
    const payments = await db.payments
      .where('sale_id')
      .equals(saleId)
      .toArray();
    expect(payments.filter((p) => p.purpose === 'refund')).toHaveLength(1);
    const ledger = await db.ledger_entries
      .where('source_id')
      .equals('refund-r6')
      .toArray();
    expect(ledger).toMatchObject([
      { party_type: 'customer', amount: -45000, source_type: 'refund' },
    ]);
  });

  it('writes the refund recipe rows and moves the sale to part_refunded', async () => {
    const { db, ctx, saleId, lines } = await t1Sale();
    const cable = lines[0];
    const result = await refundSale(
      db,
      {
        refundId: 'refund-recipe',
        saleId,
        lines: [{ saleLineId: cable?.id ?? '', qtyMilli: 1000, restock: true }],
        reason: 'Faulty',
        method: 'cash',
        print: true,
      },
      ctx,
      NOW + 1000,
    );
    expect(result.created).toBe(true);
    const rows = await db.refund_lines
      .where('refund_id')
      .equals('refund-recipe')
      .toArray();
    expect(rows).toMatchObject([
      { sale_line_id: cable?.id, qty_milli: 1000, amount: 45000, restock: 1 },
    ]);
    const moves = await db.stock_movements
      .filter((m) => m.ref_id === 'refund-recipe')
      .toArray();
    expect(moves).toMatchObject([
      { reason_code: 'refund_return', qty_delta_milli: 1000, unit_cost: null },
    ]);
    expect((await db.sales.get(saleId))?.status).toBe('part_refunded');
    const print = await db.print_jobs.toArray();
    expect(print).toMatchObject([
      { refund_id: 'refund-recipe', kind: 'refund', status: 'queued' },
    ]);
    const audit = await db.audit_log
      .where('[entity+entity_id]')
      .equals(['refunds', 'refund-recipe'])
      .toArray();
    expect(audit).toMatchObject([{ action: 'refund' }]);

    // The refund print job builds the refund receipt from the same rows.
    const [job] = await db.print_jobs.toArray();
    const receipt = job
      ? await jobReceipt(db, job as Parameters<typeof jobReceipt>[1])
      : null;
    expect(receipt).not.toBeNull();
    const { renderReceiptText } = await import('@bikri/printer');
    const text = receipt
      ? renderReceiptText(receipt.blocks, {
          charsPerLine: receipt.paper.charsPerLine,
          itemLayout: receipt.paper.itemLayout,
        })
      : '';
    expect(text).toContain('REFUND RECEIPT');
    expect(text).toContain('Cable');
    expect(text).toContain('Powered by AlgoVyn');
  });

  it('a fully udhaar bill writes no payment row and no method (R7)', async () => {
    const db = await readyDb('refund-r7');
    const ctx = await ledgerContext(db, 'st-1');
    const customer = await createCustomer(
      db,
      { name: 'Ali', phone: '' },
      'st-1',
      NOW,
    );
    // T5: three lines of Rs 100 with a Rs 100 bill discount → line 0 final 6,666.
    let cart = emptyCart('c1');
    // Carts are newest-first; add in reverse so line 1 of the bill is A.
    for (const name of ['C', 'B', 'A']) {
      const product = await saveNewProduct(
        db,
        { name_en: name, price: 10000, opening_milli: 3000 },
        ctx,
        { now: NOW },
      );
      cart = addProduct(cart, product, 1000, 'avg');
    }
    cart = {
      ...cart,
      customer_id: customer.id,
      bill_discount: { type: 'amount', value: 10000 },
    };
    const saleId = 'sale-r7';
    await completeSale(
      db,
      sale(cart, [{ method: 'udhaar', amount: 20000 }], { saleId }),
      ctx,
      NOW,
    );
    const lines = await db.sale_lines
      .where('sale_id')
      .equals(saleId)
      .sortBy('line_no');
    // R7 refunds T5's line 0, whose bill-discount share is 3,334 (final 6,666).
    const target = lines.find((l) => Number(l.bill_discount_alloc) === 3334);
    const plan = await computeRefund(
      db,
      saleId,
      [{ saleLineId: target?.id ?? '', qtyMilli: 1000, restock: false }],
      'cash',
    );
    expect(plan.exact).toBe(6666);
    expect(plan).toMatchObject({
      udhaarPart: 6666,
      paidExact: 0,
      amount: 0,
      method: null,
    });
    const result = await refundSale(
      db,
      {
        refundId: 'refund-r7',
        saleId,
        lines: [
          { saleLineId: target?.id ?? '', qtyMilli: 1000, restock: false },
        ],
        reason: 'Changed mind',
        method: null,
      },
      ctx,
      NOW + 1000,
    );
    expect(result.refund.method).toBeNull();
    expect(
      await db.payments.filter((p) => p.refund_id === 'refund-r7').count(),
    ).toBe(0);
    expect(
      await db.stock_movements.filter((m) => m.ref_id === 'refund-r7').count(),
    ).toBe(0);
  });

  it('refuses more than what is left and a voided bill', async () => {
    const { db, saleId, lines } = await t1Sale();
    await expect(
      computeRefund(
        db,
        saleId,
        [{ saleLineId: lines[0]?.id ?? '', qtyMilli: 3000, restock: true }],
        'cash',
      ),
    ).rejects.toMatchObject({ code: 'qty' });
    await db.sales.update(saleId, { status: 'void' });
    await expect(
      computeRefund(
        db,
        saleId,
        [{ saleLineId: lines[0]?.id ?? '', qtyMilli: 1000, restock: true }],
        'cash',
      ),
    ).rejects.toBeInstanceOf(RefundNotAllowedError);
  });
});

describe('refund branches', () => {
  it('honours refund_rounding modes and derives whole bills', async () => {
    const fx = await shopWithStock('refund-modes');
    await addShop(fx.db, { refund_rounding: 'down' });
    const saleId = 'mode-sale';
    await completeSale(
      fx.db,
      sale(t2Cart(fx.phone, fx.buds), [{ method: 'cash', amount: 5000000 }], {
        saleId,
      }),
      fx.ctx,
      NOW,
    );
    const line = (
      await fx.db.sale_lines.where('sale_id').equals(saleId).toArray()
    ).find((l) => l.name_snapshot === 'Earbuds');
    const request = [
      { saleLineId: line?.id ?? '', qtyMilli: 1000, restock: true },
    ];
    expect(await computeRefund(fx.db, saleId, request, 'cash')).toMatchObject({
      exact: 345977,
      amount: 345900,
      rounding: -77,
    });
    await addShop(fx.db, { refund_rounding: 'none' });
    expect((await computeRefund(fx.db, saleId, request, 'cash')).amount).toBe(
      345977,
    );
    await addShop(fx.db, { refund_rounding: 'weird' });
    expect((await computeRefund(fx.db, saleId, request, 'cash')).amount).toBe(
      346000,
    );
    await addShop(fx.db, { refund_rounding: 'nearest' });
    expect((await computeRefund(fx.db, saleId, request, 'cash')).rounding).toBe(
      23,
    );

    const whole = await shopWithStock('refund-whole');
    await addShop(whole.db);
    const budsOnly = addProduct(emptyCart('c1'), whole.buds, 1000, 'avg');
    await completeSale(
      whole.db,
      sale(budsOnly, [{ method: 'cash', amount: 350000 }], {
        saleId: 'whole-sale',
      }),
      whole.ctx,
      NOW,
    );
    const wholeLine = (await whole.db.sale_lines
      .where('sale_id')
      .equals('whole-sale')
      .first()) as { id: string };
    const plan = await computeRefund(
      whole.db,
      'whole-sale',
      [{ saleLineId: wholeLine.id, qtyMilli: 1000, restock: true }],
      'cash',
    );
    expect(plan.kind).toBe('whole');
    const result = await refundSale(
      whole.db,
      {
        refundId: 'whole-refund',
        saleId: 'whole-sale',
        lines: [{ saleLineId: wholeLine.id, qtyMilli: 1000, restock: true }],
        reason: 'Faulty',
        method: 'cash',
      },
      whole.ctx,
      NOW + 1000,
    );
    expect(result.refund.kind).toBe('whole');
  });

  it('does not return stock for untracked or quick-sale lines', async () => {
    const db = await readyDb('refund-untracked');
    await addShop(db);
    const ctx = await ledgerContext(db, 'st-1');
    const service = await saveNewProduct(
      db,
      { name_en: 'Service', price: 100000, track_stock: false },
      ctx,
      { now: NOW },
    );
    const untracked = addProduct(emptyCart('c1'), service, 1000, 'avg');
    const input = sale(untracked, [{ method: 'cash', amount: 100000 }], {
      saleId: 'untracked-sale',
    });
    await completeSale(db, input, ctx, NOW);
    const serviceLine = (await db.sale_lines
      .where('sale_id')
      .equals('untracked-sale')
      .first()) as { id: string };
    const plan = await computeRefund(
      db,
      'untracked-sale',
      [{ saleLineId: serviceLine.id, qtyMilli: 1000, restock: true }],
      'cash',
    );
    expect(plan.lines[0]?.trackStock).toBe(false);
    await refundSale(
      db,
      {
        refundId: 'untracked-refund',
        saleId: 'untracked-sale',
        lines: [{ saleLineId: serviceLine.id, qtyMilli: 1000, restock: true }],
        reason: 'Faulty',
        method: 'cash',
      },
      ctx,
      NOW + 1000,
    );
    expect(
      await db.stock_movements
        .filter((m) => m.ref_id === 'untracked-refund')
        .count(),
    ).toBe(0);

    const quick = addQuickSale(emptyCart('c1'), {
      name: 'Quick item',
      price: 100000,
      qtyMilli: 1000,
    });
    const quickSale = sale(quick, [{ method: 'cash', amount: 100000 }], {
      saleId: 'quick-refund-sale',
    });
    await completeSale(db, quickSale, ctx, NOW + 2000);
    const quickLine = (await db.sale_lines
      .where('sale_id')
      .equals('quick-refund-sale')
      .first()) as { id: string };
    expect(
      await computeRefund(
        db,
        'quick-refund-sale',
        [{ saleLineId: quickLine.id, qtyMilli: 1000, restock: true }],
        'cash',
      ),
    ).toMatchObject({
      lines: [{ trackStock: false, unit: 'pc' }],
    });
  });

  it('covers refund errors, a repeated refund id and an override', async () => {
    const fx = await shopWithStock('refund-errors');
    await addShop(fx.db);
    const saleId = 'error-sale';
    await completeSale(
      fx.db,
      sale(t2Cart(fx.phone, fx.buds), [{ method: 'cash', amount: 5000000 }], {
        saleId,
      }),
      fx.ctx,
      NOW,
    );
    const line = (
      await fx.db.sale_lines.where('sale_id').equals(saleId).toArray()
    ).find((l) => l.name_snapshot === 'Earbuds') as { id: string };
    const request = [{ saleLineId: line.id, qtyMilli: 1000, restock: true }];
    await expect(
      computeRefund(fx.db, 'missing', request, 'cash'),
    ).rejects.toMatchObject({ code: 'missing' });
    await expect(
      computeRefund(
        fx.db,
        saleId,
        [...request, { saleLineId: 'nope', qtyMilli: 1000, restock: true }],
        'cash',
      ),
    ).rejects.toMatchObject({ code: 'line' });
    await expect(
      refundSale(
        fx.db,
        {
          refundId: 'blank',
          saleId,
          lines: request,
          reason: ' ',
          method: 'cash',
        },
        fx.ctx,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'reason' });
    await expect(
      refundSale(
        fx.db,
        {
          refundId: 'long',
          saleId,
          lines: request,
          reason: 'x'.repeat(121),
          method: 'cash',
        },
        fx.ctx,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'reason' });

    const first = await refundSale(
      fx.db,
      {
        refundId: 'override-refund',
        saleId,
        lines: request,
        reason: 'Faulty',
        method: 'cash',
        override: { approved_by: 'st-1' },
      },
      fx.ctx,
      NOW + 1000,
    );
    expect(first.created).toBe(true);
    const again = await refundSale(
      fx.db,
      {
        refundId: 'override-refund',
        saleId,
        lines: request,
        reason: 'Again',
        method: 'cash',
      },
      fx.ctx,
      NOW + 2000,
    );
    expect(again.created).toBe(false);
    expect(
      await fx.db.audit_log
        .where('[entity+entity_id]')
        .equals(['refunds', 'override-refund'])
        .toArray(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'override' }),
        expect.objectContaining({ action: 'refund' }),
      ]),
    );

    // A bill with no lines left cannot be refunded.
    const empty = await readyDb('refund-empty');
    await addShop(empty);
    await empty.sales.add({
      id: 'empty-sale',
      invoice_no: 'A-A-empty',
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
      status: 'paid',
      replaces_sale_id: null,
      note: '',
    });
    await expect(
      computeRefund(
        empty,
        'empty-sale',
        [{ saleLineId: 'x', qtyMilli: 1000, restock: true }],
        'cash',
      ),
    ).rejects.toMatchObject({ code: 'missing' });
  });
});
