import { businessDate } from '@bikri/core';
import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { jobReceipt } from '../print/receiptFiles.ts';
import { ledgerContext } from './catalog.ts';
import {
  closeDay,
  dayCloseCsv,
  dayCloseData,
  dayCloseInfo,
  queueDayClosePrint,
} from './dayClose.ts';
import { loadDayCloseReceipt } from './dayCloseReceipt.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const TZ = 'Asia/Karachi';
const TODAY = businessDate(NOW, TZ);

async function setup(prefix = 'dayclose') {
  const db = await readyDb(prefix);
  await addShop(db, { name: 'Bikri', timezone: TZ });
  const ctx = await ledgerContext(db, 'st-1');
  return { db, ctx };
}

function payment(id: string, over: Record<string, unknown>): SyncedRow {
  return {
    id,
    direction: 'in',
    method: 'cash',
    purpose: 'sale',
    amount: 0,
    cash_tendered: null,
    change_given: null,
    reference: '',
    sale_id: null,
    refund_id: null,
    purchase_id: null,
    supplier_return_id: null,
    party_type: null,
    party_id: null,
    note: '',
    branch_id: 'br-1',
    device_id: 'dev-1',
    staff_id: 'st-1',
    business_date: TODAY,
    created_at: NOW - 1000,
    ...over,
  } as SyncedRow;
}

describe('day close (T-047)', () => {
  it('informational card/bank/udhaar figures net voids and refunds like Reports', async () => {
    const { db } = await setup('info');
    await db.sales.bulkAdd([
      {
        id: 's-void',
        status: 'void',
        udhaar_amount: 100000,
        device_id: 'dev-1',
        business_date: TODAY,
        created_at: NOW - 900,
      } as SyncedRow,
      {
        id: 's-live',
        status: 'paid',
        udhaar_amount: 100000,
        device_id: 'dev-1',
        business_date: TODAY,
        created_at: NOW - 800,
      } as SyncedRow,
    ]);
    await db.payments.bulkAdd([
      payment('void-in', {
        method: 'card',
        amount: 100000,
        purpose: 'sale',
        created_at: NOW - 900,
      }),
      payment('void-out', {
        direction: 'out',
        method: 'card',
        amount: 100000,
        purpose: 'void',
        created_at: NOW - 850,
      }),
      payment('live-card', {
        method: 'card',
        amount: 300000,
        purpose: 'sale',
        created_at: NOW - 800,
      }),
      payment('bank-in', {
        method: 'bank_wallet',
        amount: 400000,
        purpose: 'sale',
        created_at: NOW - 790,
      }),
      payment('bank-void', {
        direction: 'out',
        method: 'bank_wallet',
        amount: 100000,
        purpose: 'void',
        created_at: NOW - 780,
      }),
    ]);
    await db.refunds.bulkAdd([
      {
        id: 'refund-live',
        sale_id: 's-live',
        method: 'card',
        amount: 50000,
        udhaar_part: 20000,
        device_id: 'dev-1',
        business_date: TODAY,
        created_at: NOW - 700,
      } as SyncedRow,
      {
        id: 'refund-bank',
        sale_id: 's-live',
        method: 'bank_wallet',
        amount: 30000,
        udhaar_part: 0,
        device_id: 'dev-1',
        business_date: TODAY,
        created_at: NOW - 690,
      } as SyncedRow,
    ]);
    const info = await dayCloseInfo(db, 'dev-1', NOW - 10000, NOW);
    expect(info).toMatchObject({
      cardTotal: 250000,
      bankTotal: 270000,
      udhaarGiven: 80000,
      bills: 1,
      refunds: 2,
    });
  });

  it('first close without an opening override opens at zero', async () => {
    const { db } = await setup('first-zero');
    const data = await dayCloseData(db, 'dev-1', NOW);
    expect(data.openingCash).toBe(0);
    expect(data.firstClose).toBe(true);
  });

  it('AC 1: vector D1 stores the exact components and difference', async () => {
    const { db, ctx } = await setup();
    await db.payments.bulkAdd([
      payment('sale-cash', { amount: 4300000, purpose: 'sale' }),
      payment('udhaar-in', { amount: 50000, purpose: 'customer_payment' }),
      payment('refund', {
        direction: 'out',
        amount: 346000,
        purpose: 'refund',
      }),
      payment('supplier', {
        direction: 'out',
        amount: 550000,
        purpose: 'supplier_payment',
      }),
      payment('card', { method: 'card', amount: 100000, purpose: 'sale' }),
      payment('bank', {
        method: 'bank_wallet',
        amount: 200000,
        purpose: 'sale',
      }),
    ]);
    await db.expenses.add({
      id: 'expense',
      category_id: 'ec-1',
      amount: 30000,
      method: 'cash',
      payee: '',
      note: '',
      reverses_id: null,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW - 1000,
    });
    await db.cash_moves.bulkAdd([
      {
        id: 'float-in',
        kind: 'pay_in',
        amount: 1000,
        reason: 'Float',
        branch_id: 'br-1',
        device_id: 'dev-1',
        staff_id: 'st-1',
        business_date: TODAY,
        created_at: NOW - 900,
      },
      {
        id: 'float-out',
        kind: 'pay_out',
        amount: 1000,
        reason: 'Float out',
        branch_id: 'br-1',
        device_id: 'dev-1',
        staff_id: 'st-1',
        business_date: TODAY,
        created_at: NOW - 800,
      },
    ]);
    const data = await dayCloseData(db, 'dev-1', NOW, 500000);
    expect(data).toMatchObject({
      openingCash: 500000,
      firstClose: true,
      expectedCash: 3924000,
      components: {
        cash_sales: 4300000,
        udhaar_cash_in: 50000,
        cash_refunds: 346000,
        cash_expenses: 30000,
        supplier_cash_out: 550000,
        pay_ins: 1000,
        pay_outs: 1000,
        cardTotal: 100000,
        bankTotal: 200000,
      },
    });
    const row = await closeDay(
      db,
      {
        dayCloseId: 'close-d1',
        countedCash: 3920000,
        openingCash: 500000,
      },
      ctx,
      { now: NOW + 1000, print: true },
    );
    expect(row).toMatchObject({
      opening_cash: 500000,
      cash_sales: 4300000,
      udhaar_cash_in: 50000,
      cash_refunds: 346000,
      cash_expenses: 30000,
      supplier_cash_out: 550000,
      expected_cash: 3924000,
      counted_cash: 3920000,
      difference: -4000,
    });
    expect(
      await db.print_jobs.filter((j) => j.day_close_id === 'close-d1').count(),
    ).toBe(1);
    const receipt = await loadDayCloseReceipt(db, 'close-d1');
    expect(receipt).toMatchObject({
      expectedCash: 3924000,
      countedCash: 3920000,
      difference: -4000,
      cardTotal: 100000,
      bankTotal: 200000,
    });
    const csv = dayCloseCsv(receipt as NonNullable<typeof receipt>, TODAY, TZ);
    expect(csv.split('\r\n')[0]).toBe(
      'date,device,cashier,period_start,period_end,opening,cash_sales,udhaar_in,pay_ins,supplier_in,refunds,expenses,supplier_out,pay_outs,expected,counted,difference,card,bank,udhaar_given,bills,refunds_count,note',
    );
    expect(csv).toContain('39240.00');
    expect(csv).toContain('-40.00');
    const job = await db.print_jobs
      .filter((j) => j.day_close_id === 'close-d1')
      .first();
    expect(job ? await jobReceipt(db, job) : null).not.toBeNull();
  });

  it('AC 2/3: D2 is correct; a previous close provides the opening and D3 supplier cash', async () => {
    const { db, ctx } = await setup('d2');
    await db.payments.bulkAdd([
      payment('d2-in', { amount: 50000, purpose: 'customer_payment' }),
    ]);
    await db.expenses.add({
      id: 'd2-expense',
      category_id: 'ec-1',
      amount: 30000,
      method: 'cash',
      payee: '',
      note: '',
      reverses_id: null,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW - 500,
    });
    const d2 = await dayCloseData(db, 'dev-1', NOW);
    expect(d2.expectedCash).toBe(20000);
    await closeDay(
      db,
      { dayCloseId: 'close-d2', countedCash: 20000, note: '' },
      ctx,
      { now: NOW + 1000, print: false },
    );
  });

  it('AC 3: D3 adds cash received back from a supplier', async () => {
    const { db } = await setup('d3');
    await db.day_closes.add({
      id: 'previous',
      device_id: 'dev-1',
      branch_id: 'br-1',
      staff_id: 'st-1',
      business_date: businessDate(NOW - 86_400_000, TZ),
      period_start: 0,
      period_end: NOW - 1000,
      opening_cash: 0,
      cash_sales: 0,
      udhaar_cash_in: 0,
      pay_ins: 0,
      supplier_cash_in: 0,
      cash_refunds: 0,
      cash_expenses: 0,
      supplier_cash_out: 0,
      pay_outs: 0,
      expected_cash: 200000,
      counted_cash: 200000,
      difference: 0,
      denominations_json: null,
      note: '',
      created_at: NOW - 1000,
    } as SyncedRow);
    await db.payments.bulkAdd([
      payment('d3-sale', { amount: 150000, created_at: NOW - 500 }),
      payment('d3-supplier', {
        direction: 'in',
        amount: 55000,
        purpose: 'supplier_refund',
        created_at: NOW - 400,
      }),
    ]);
    const d3 = await dayCloseData(db, 'dev-1', NOW);
    expect(d3).toMatchObject({
      openingCash: 200000,
      firstClose: false,
      expectedCash: 405000,
    });
  });

  it('requires a note for a large difference and audits it', async () => {
    const { db, ctx } = await setup('difference');
    await expect(
      closeDay(
        db,
        { dayCloseId: 'diff', countedCash: 0, openingCash: 50000 },
        ctx,
        { now: NOW, print: false },
      ),
    ).rejects.toThrow();
    await closeDay(
      db,
      {
        dayCloseId: 'diff',
        countedCash: 0,
        openingCash: 50000,
        note: 'Cash short',
      },
      ctx,
      { now: NOW, print: false },
    );
    expect(
      await db.audit_log
        .where('[entity+entity_id]')
        .equals(['day_closes', 'diff'])
        .toArray(),
    ).toMatchObject([{ action: 'day_close_difference' }]);
  });

  it('returns a concurrent close when the form was prepared for the old period', async () => {
    const { db, ctx } = await setup('concurrent');
    const first = await closeDay(
      db,
      { dayCloseId: 'first', countedCash: 0, note: 'First' },
      ctx,
      { now: NOW + 1000, print: false },
    );
    const duplicate = await closeDay(
      db,
      {
        dayCloseId: 'second',
        countedCash: 5000,
        note: 'Stale form',
        expectedPeriodStart: Number(first.period_start),
      },
      ctx,
      { now: NOW + 2000, print: false },
    );
    expect(duplicate.id).toBe(first.id);
    expect(await db.day_closes.count()).toBe(1);
    const next = await closeDay(
      db,
      {
        dayCloseId: 'third',
        countedCash: 0,
        note: 'Fresh period',
        expectedPeriodStart: Number(first.period_end),
      },
      ctx,
      { now: NOW + 3000, print: false },
    );
    expect(next.id).not.toBe(first.id);
  });

  it('keeps devices apart and is idempotent', async () => {
    const { db, ctx } = await setup('devices');
    await db.payments.add(
      payment('other-device', {
        device_id: 'dev-2',
        amount: 99999,
        created_at: NOW - 500,
      }),
    );
    const data = await dayCloseData(db, 'dev-1', NOW);
    expect(data.components.cash_sales).toBe(0);
    const first = await closeDay(
      db,
      { dayCloseId: 'same', countedCash: 0, note: 'Zero' },
      ctx,
      { now: NOW + 1000, print: false },
    );
    const again = await closeDay(
      db,
      { dayCloseId: 'same', countedCash: 999 },
      ctx,
      { now: NOW + 2000, print: false },
    );
    expect(again.counted_cash).toBe(first.counted_cash);
    expect(
      await queueDayClosePrint(db, 'same', { now: NOW + 3000 }),
    ).toBeTruthy();
    expect(
      (await dayCloseData(db, 'dev-1', NOW + 4000)).recentClose,
    ).not.toBeNull();
    expect(await loadDayCloseReceipt(db, 'missing')).toBeNull();
  });
});
