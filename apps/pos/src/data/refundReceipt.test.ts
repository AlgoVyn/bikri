import type { PrintJob, SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { jobReceipt } from '../print/receiptFiles.ts';
import { createCustomer } from './customers.ts';
import { loadRefundReceipt, queueRefundPrint } from './refundReceipt.ts';
import { refundSale } from './refunds.ts';
import { completeSale } from './sale.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, sale, shopWithStock, t2Cart } from './testShop.ts';

afterEach(dropTestDbs);

const fullShop = {
  tax_label: 'GST',
  number_grouping: 'lakh',
  ntn: '1234567',
  strn: '7654321',
  print_warranty: 1,
  show_you_saved: 1,
  timezone: 'UTC',
  receipt_language: 'roman-ur',
  show_payment_details: 0,
  show_cashier_on_receipt: 0,
  receipt_header: 'Header',
  receipt_footer: 'Footer',
};

async function refundWith(over: { customer?: boolean; card?: boolean } = {}) {
  const fx = await shopWithStock('rr');
  await addShop(fx.db, fullShop);
  let cart = t2Cart(fx.phone, fx.buds);
  let rows: { method: 'cash' | 'card' | 'udhaar'; amount: number }[] = [
    { method: 'cash', amount: 5000000 },
  ];
  if (over.customer) {
    const ali = await createCustomer(
      fx.db,
      { name: 'Ali', phone: '+923001234567' },
      'st-1',
      NOW,
    );
    cart = { ...cart, customer_id: ali.id };
    rows = [
      { method: 'cash', amount: 100000 },
      { method: 'udhaar', amount: 4200000 },
    ];
  } else if (over.card) {
    rows = [{ method: 'card', amount: 4300000 }];
  }
  const saleId = over.card
    ? 'rr-card'
    : over.customer
      ? 'rr-udhaar'
      : 'rr-cash';
  const { sale: row } = await completeSale(
    fx.db,
    sale(cart, rows, { saleId }),
    fx.ctx,
    NOW,
  );
  const buds = (
    await fx.db.sale_lines.where('sale_id').equals(saleId).toArray()
  ).find((l) => l.name_snapshot === 'Earbuds');
  const result = await refundSale(
    fx.db,
    {
      refundId: over.card
        ? 'refund-card'
        : over.customer
          ? 'refund-udhaar'
          : 'refund-cash',
      saleId,
      lines: [
        {
          saleLineId: buds?.id ?? '',
          qtyMilli: 1000,
          restock: true,
        },
      ],
      reason: 'Faulty',
      method: over.card ? 'card' : 'cash',
    },
    fx.ctx,
    NOW + 1000,
  );
  return { ...fx, row, saleId, refundId: String(result.refund.id) };
}

describe('refund receipt data', () => {
  it('loads a cash refund with a customer and the khata balance', async () => {
    const { db, refundId, saleId } = await refundWith({ customer: true });
    const r = await loadRefundReceipt(db, refundId);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      customerName: 'Ali',
      staffName: 'Adnan',
      originalInvoiceNo: 'A-A-1',
      exactAmount: 345977,
      amount: 100000,
      udhaarPart: 245977,
      method: 'cash',
      reason: 'Faulty',
    });
    expect(r?.khataBalancePaisa).toBe(4200000 - 245977);
    expect(r?.lines).toMatchObject([{ name: 'Earbuds', qtyMilli: 1000 }]);
    expect(r?.shop).toMatchObject({
      name: 'Bilal Mobile',
      taxLabel: 'GST',
      numberGrouping: 'lakh',
      ntn: '1234567',
      strn: '7654321',
      printWarranty: true,
      showYouSaved: true,
      timeZone: 'UTC',
      showPaymentDetails: false,
      showCashierOnReceipt: false,
      receiptHeader: 'Header',
      receiptFooter: 'Footer',
    });
    const job = await jobReceipt(db, {
      id: 'x',
      refund_id: refundId,
      kind: 'refund',
      status: 'queued',
      created_at: NOW,
    });
    expect(job?.blocks.length).toBeGreaterThan(0);
    expect((await db.sales.get(saleId))?.status).toBe('part_refunded');
  });

  it('loads a card refund without khata and a cash refund without a customer', async () => {
    const card = await refundWith({ card: true });
    expect(await loadRefundReceipt(card.db, card.refundId)).toMatchObject({
      customerName: null,
      method: 'card',
      udhaarPart: 0,
      khataBalancePaisa: null,
      amount: 345977,
      rounding: 0,
    });
    const cash = await refundWith();
    expect(await loadRefundReceipt(cash.db, cash.refundId)).toMatchObject({
      customerName: null,
      method: 'cash',
      khataBalancePaisa: null,
      amount: 346000,
      rounding: 23,
    });
  });

  it('handles missing rows, missing staff and whole-khata refunds', async () => {
    const { db, refundId } = await refundWith({ customer: true });
    expect(await loadRefundReceipt(db, 'missing')).toBeNull();
    await db.refunds.add({
      id: 'orphan',
      sale_id: 'missing-sale',
      kind: 'partial',
      reason: 'Faulty',
      method: null,
      exact_amount: 1,
      udhaar_part: 1,
      rounding: 0,
      amount: 0,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: '2026-10-27',
      created_at: NOW,
    });
    expect(await loadRefundReceipt(db, 'orphan')).toBeNull();

    await db.refunds.update(refundId, { staff_id: '' });
    expect((await loadRefundReceipt(db, refundId))?.staffName).toBeNull();
    const line = (await db.refund_lines
      .where('refund_id')
      .equals(refundId)
      .first()) as SyncedRow;
    await db.refund_lines.update(line.id, { sale_line_id: 'missing-line' });
    expect((await loadRefundReceipt(db, refundId))?.lines[0]?.name).toBe('');
  });

  it('loads a fully-khata refund (method NULL, amount 0)', async () => {
    const fx = await shopWithStock('rr-khata');
    await addShop(fx.db, fullShop);
    const ali = await createCustomer(
      fx.db,
      { name: 'Ali', phone: '+923001234567' },
      'st-1',
      NOW,
    );
    const cart = { ...t2Cart(fx.phone, fx.buds), customer_id: ali.id };
    const saleId = 'rr-khata-sale';
    await completeSale(
      fx.db,
      sale(cart, [{ method: 'udhaar', amount: 4300000 }], { saleId }),
      fx.ctx,
      NOW,
    );
    const buds = (
      await fx.db.sale_lines.where('sale_id').equals(saleId).toArray()
    ).find((l) => l.name_snapshot === 'Earbuds');
    const { refund } = await refundSale(
      fx.db,
      {
        refundId: 'refund-khata',
        saleId,
        lines: [{ saleLineId: buds?.id ?? '', qtyMilli: 1000, restock: false }],
        reason: 'Changed mind',
        method: null,
      },
      fx.ctx,
      NOW + 1000,
    );
    const r = await loadRefundReceipt(fx.db, String(refund.id));
    expect(r).toMatchObject({
      method: null,
      amount: 0,
      udhaarPart: 345977,
      customerName: 'Ali',
    });
    expect(r?.khataBalancePaisa).toBe(4300000 - 345977);
  });

  it('queues a refund print job and ignores jobs with no receipt', async () => {
    const { db, refundId } = await refundWith();
    const id = await queueRefundPrint(db, refundId);
    const job = (await db.print_jobs.get(id)) as PrintJob;
    expect(job).toMatchObject({ refund_id: refundId, kind: 'refund' });
    expect(
      await jobReceipt(db, {
        id: 'none',
        kind: 'sale',
        status: 'queued',
        created_at: NOW,
      }),
    ).toBeNull();
  });
});
