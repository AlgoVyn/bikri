import { afterEach, describe, expect, it } from 'vitest';
import { addProduct, emptyCart } from './cart.ts';
import { createCustomer } from './customers.ts';
import { refundSale } from './refunds.ts';
import { completeSale } from './sale.ts';
import {
  billDetail,
  rangeFor,
  salesCsv,
  salesHistory,
  shopTimeZone,
} from './salesHistory.ts';
import { dropTestDbs } from './testDb.ts';
import { NOW, sale, shopWithStock, t2Cart } from './testShop.ts';

afterEach(dropTestDbs);

async function twoBills() {
  const { db, ctx, phone, buds } = await shopWithStock('history');
  const firstId = 'sale-first';
  await completeSale(
    db,
    sale(t2Cart(phone, buds), [{ method: 'cash', amount: 5000000 }], {
      saleId: firstId,
    }),
    ctx,
    NOW,
  );
  const customer = await createCustomer(
    db,
    { name: 'Ali Raza', phone: '+923001234567' },
    'st-1',
    NOW,
  );
  let cart = addProduct(emptyCart('c1'), phone, 1000, 'avg');
  cart = { ...cart, customer_id: customer.id };
  const secondId = 'sale-second';
  await completeSale(
    db,
    sale(cart, [{ method: 'card', amount: 4200000 }], { saleId: secondId }),
    ctx,
    NOW + 1000,
  );
  const budsLine = (
    await db.sale_lines.where('sale_id').equals(firstId).toArray()
  ).find((l) => l.name_snapshot === 'Earbuds');
  await refundSale(
    db,
    {
      refundId: 'history-refund',
      saleId: firstId,
      lines: [
        { saleLineId: budsLine?.id ?? '', qtyMilli: 1000, restock: true },
      ],
      reason: 'Faulty',
      method: 'cash',
    },
    ctx,
    NOW + 2000,
  );
  return { db, firstId, secondId, customerId: customer.id };
}

describe('sales history (screens/10)', () => {
  it('lists newest first with methods, refunds and a net summary', async () => {
    const { db, firstId, secondId } = await twoBills();
    const day = rangeFor('today', NOW, 'Asia/Karachi');
    const history = await salesHistory(db, day);
    expect(history.rows.map((r) => r.sale.id)).toEqual([secondId, firstId]);
    expect(history.rows[0]).toMatchObject({
      customerName: 'Ali Raza',
      staffName: 'Adnan',
      deviceName: 'Counter 1',
      methods: ['card'],
      refunded: 0,
    });
    expect(history.rows[1]).toMatchObject({
      methods: ['cash'],
      refunded: 346000,
    });
    expect(history.summary).toMatchObject({
      bills: 2,
      refunds: 346000,
      sold: 4200000 + 4300000 - 346000,
    });
    expect(history.days).toHaveLength(1);
    expect(history.days[0]?.bills).toBe(2);
    expect(history.days[0]?.total).toBe(8500000);
  });

  it('filters by method, status, cashier and device, and searches invoice, customer and product', async () => {
    const { db, firstId, secondId } = await twoBills();
    const day = rangeFor('today', NOW, 'Asia/Karachi');
    const card = await salesHistory(db, { ...day, method: 'card' });
    expect(card.rows.map((r) => r.sale.id)).toEqual([secondId]);
    const refunded = await salesHistory(db, {
      ...day,
      status: 'part_refunded',
    });
    expect(refunded.rows.map((r) => r.sale.id)).toEqual([firstId]);
    const byStaff = await salesHistory(db, { ...day, staffId: 'st-1' });
    expect(byStaff.rows).toHaveLength(2);
    const byDevice = await salesHistory(db, { ...day, deviceId: 'dev-1' });
    expect(byDevice.rows).toHaveLength(2);
    expect(
      (await salesHistory(db, { ...day, query: 'A-A-1' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual([firstId]);
    expect(
      (await salesHistory(db, { ...day, query: 'ali raza' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual([secondId]);
    expect(
      (await salesHistory(db, { ...day, query: 'earbuds' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual([firstId]);
    expect((await salesHistory(db, { ...day, query: 'nothing' })).rows).toEqual(
      [],
    );
  });

  it('exports the documented CSV header and one row per bill', async () => {
    const { db } = await twoBills();
    const day = rangeFor('today', NOW, 'Asia/Karachi');
    const zone = await shopTimeZone(db);
    const history = await salesHistory(db, day);
    const csv = salesCsv(history.rows, zone);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'invoice_no,date,time,customer,items,subtotal,discounts,tax,total,cash,card,bank_wallet,udhaar,refunded,status,cashier,device',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(
      'A-A-2,2026-10-27,14:00,Ali Raza,1,42000,0,0,42000,0,42000,0,0,0,paid,Adnan,Counter 1',
    );
    expect(lines[2]).toContain(
      'A-A-1,2026-10-27,14:00,,2,43500,2500,0,43000,43000,0,0,0,3460,part_refunded,Adnan,Counter 1',
    );
  });

  it('bill detail shows refunded and kept quantities, payments and the audit trail', async () => {
    const { db, firstId } = await twoBills();
    const detail = await billDetail(db, firstId);
    expect(detail).not.toBeNull();
    const buds = detail?.lines.find((l) => l.line.name_snapshot === 'Earbuds');
    expect(buds).toMatchObject({
      refundedMilli: 1000,
      keptMilli: 0,
      trackStock: true,
      unit: 'pc',
    });
    expect(detail?.refunds).toHaveLength(1);
    expect(detail?.refunds[0]?.refund).toMatchObject({
      exact_amount: 345977,
      amount: 346000,
      reason: 'Faulty',
    });
    expect(detail?.payments.some((p) => p.purpose === 'sale')).toBe(true);
    expect(detail?.payments.some((p) => p.purpose === 'refund')).toBe(true);
    expect(detail?.staffName).toBe('Adnan');
    expect(detail?.deviceName).toBe('Counter 1');
    expect(detail?.refundedTotal).toBe(346000);
    expect(detail?.audit.map((a) => a.action)).toContain('refund');
    expect(detail?.conflicts).toEqual([]);

    await db.sync_conflicts.put({
      id: 'conflict-1',
      tbl: 'refund_lines',
      row_id: 'rl-1',
      kind: 'over_refund',
      fields_json: JSON.stringify({ sale_id: firstId, excess_milli: 1000 }),
      resolution: 'needs_owner',
      at: NOW + 4000,
    });
    const withConflict = await billDetail(db, firstId);
    expect(withConflict?.conflicts).toHaveLength(1);
  });

  it('flags a failed print until a reprint succeeds', async () => {
    const { db, firstId } = await twoBills();
    await db.print_jobs.put({
      id: 'job-failed',
      sale_id: firstId,
      kind: 'sale',
      status: 'failed',
      error: 'NO_PRINTER',
      created_at: NOW + 3000,
    });
    const day = rangeFor('today', NOW, 'Asia/Karachi');
    const rows = await salesHistory(db, day);
    expect(rows.rows.find((r) => r.sale.id === firstId)).toMatchObject({
      printFailed: true,
      printJobId: 'job-failed',
    });
    await db.print_jobs.update('job-failed', { status: 'done' });
    const after = await salesHistory(db, day);
    expect(after.rows.find((r) => r.sale.id === firstId)?.printFailed).toBe(
      false,
    );
  });
});
