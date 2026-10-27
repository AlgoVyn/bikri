import { businessDate, newId } from '@bikri/core';
import { afterEach, describe, expect, it } from 'vitest';
import { addProduct, emptyCart } from './cart.ts';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import {
  CustomerBalanceError,
  createCustomer,
  createCustomerAccount,
  DuplicatePhoneError,
  deleteCustomer,
  updateCustomer,
} from './customers.ts';
import { refundSale } from './refunds.ts';
import { completeSale } from './sale.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, readyDb, sale } from './testShop.ts';
import {
  chaseCsv,
  chaseList,
  createPromise,
  customerList,
  customerStatement,
  customersCsv,
  PaymentError,
  PromiseError,
  receivePayment,
  refreshPromises,
  reminderLink,
  reminderMessage,
  statementCsv,
} from './udhaar.ts';
import { voidSale } from './voids.ts';

afterEach(dropTestDbs);

const TZ = 'Asia/Karachi';
const TODAY = businessDate(NOW, TZ);

async function setup(prefix = 'udhaar') {
  const db = await readyDb(prefix);
  await addShop(db, { name: 'Bikri', timezone: TZ });
  const ctx = await ledgerContext(db, 'st-1');
  return { db, ctx };
}

async function customer(
  db: Awaited<ReturnType<typeof readyDb>>,
  name = 'Ali',
  phone = '+923001234567',
) {
  return createCustomer(db, { name, phone }, 'st-1', NOW);
}

async function udhaarSale(
  db: Awaited<ReturnType<typeof readyDb>>,
  ctx: Awaited<ReturnType<typeof ledgerContext>>,
  customerId: string,
  amount: number,
  now = NOW,
  name = 'Item',
) {
  const product = await saveNewProduct(
    db,
    { name_en: name, price: amount, opening_milli: 100000 },
    ctx,
    { now },
  );
  const cart = {
    ...addProduct(emptyCart('c1'), product, 1000, 'avg'),
    customer_id: customerId,
  };
  const saleId = `sale-${now}-${customerId}`;
  await completeSale(
    db,
    sale(cart, [{ method: 'udhaar', amount }], { saleId }),
    ctx,
    now,
  );
  return saleId;
}

describe('udhaar data', () => {
  it('AC 1: a Rs 3,000 udhaar sale and a Rs 2,110 payment show 3,000 then 890', async () => {
    const { db, ctx } = await setup();
    const ali = await customer(db);
    await udhaarSale(db, ctx, ali.id, 300000);
    await receivePayment(
      db,
      {
        paymentId: 'pay-1',
        customerId: ali.id,
        amount: 211000,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 1000 },
    );
    const statement = await customerStatement(db, ali.id);
    expect(statement.rows.map((r) => [r.debit, r.credit, r.balance])).toEqual([
      [300000, 0, 300000],
      [0, 211000, 89000],
    ]);
    expect(statement.balance).toBe(89000);
    expect((await customerList(db, { today: TODAY })).rows[0]).toMatchObject({
      balance: 89000,
    });
  });

  it('AC 2/3: reminder text and wa.me URL; no phone means no link', () => {
    const message = reminderMessage('en', {
      name: 'Ali',
      shop: 'Bikri',
      balance: 300000,
      date: '27 Oct 2026',
    });
    expect(message).toBe(
      'Assalam-o-Alaikum Ali, your balance at Bikri is Rs 3,000 (as of 27 Oct 2026). Please clear it at your convenience. Thank you!',
    );
    const link = reminderLink('+923001234567', message);
    expect(link).toBe(
      `https://wa.me/923001234567?text=${encodeURIComponent(message)}`,
    );
    expect(
      link?.startsWith(
        'https://wa.me/923001234567?text=Assalam-o-Alaikum%20Ali%2C',
      ),
    ).toBe(true);
    expect(reminderLink('', message)).toBeNull();
    expect(
      reminderMessage('roman-ur', {
        name: 'Ali',
        shop: 'Bikri',
        balance: 100,
        date: 'x',
      }),
    ).toContain('baqaya Rs 1');
    expect(
      reminderMessage('ur', {
        name: 'Ali',
        shop: 'Bikri',
        balance: 100,
        date: 'x',
      }),
    ).toContain('بقایا');
  });

  it('AC 4: a promise is kept by a payment that covers it', async () => {
    const { db, ctx } = await setup('promise');
    const ali = await customer(db);
    await udhaarSale(db, ctx, ali.id, 300000);
    const promise = await createPromise(
      db,
      {
        customerId: ali.id,
        promisedOn: businessDate(NOW + 86_400_000, TZ),
        amount: 200000,
        note: 'Tomorrow',
      },
      'st-1',
      { today: TODAY, now: NOW },
    );
    expect(promise.status).toBe('open');
    await receivePayment(
      db,
      {
        paymentId: 'promise-pay',
        customerId: ali.id,
        amount: 200000,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 1000 },
    );
    expect((await db.promises.get(promise.id))?.status).toBe('kept');
    expect(
      await db.outbox
        .filter((op) => op.tbl === 'promises' && op.row_id === promise.id)
        .count(),
    ).toBeGreaterThan(0);
  });

  it('refreshes promises to broken the day after the date', async () => {
    const { db, ctx } = await setup('broken');
    const ali = await customer(db);
    await udhaarSale(db, ctx, ali.id, 100000);
    const promise = await createPromise(
      db,
      { customerId: ali.id, promisedOn: '2026-10-26', amount: null },
      'st-1',
      { today: '2026-10-25', now: NOW },
    );
    expect(await refreshPromises(db, { today: TODAY, now: NOW })).toBe(1);
    expect((await db.promises.get(promise.id))?.status).toBe('broken');
  });

  it('AC 5: chase groups sum to the total, promises due at the top', async () => {
    const { db, ctx } = await setup('chase');
    const a = await customer(db, 'A', '');
    const b = await customer(db, 'B', '');
    const c = await customer(db, 'C', '');
    const d = await customer(db, 'D', '');
    await udhaarSale(db, ctx, a.id, 100000, NOW - 40 * 86_400_000);
    await udhaarSale(db, ctx, b.id, 200000, NOW - 20 * 86_400_000);
    await udhaarSale(db, ctx, c.id, 300000, NOW - 2 * 86_400_000);
    await udhaarSale(db, ctx, d.id, 40000, NOW - 2 * 86_400_000);
    await createPromise(
      db,
      { customerId: d.id, promisedOn: TODAY, amount: 40000 },
      'st-1',
      { today: TODAY, now: NOW },
    );
    const list = await chaseList(db, { today: TODAY, now: NOW });
    expect(list.groups.map((g) => g.key)).toEqual([
      'promise',
      '0-7',
      '8-30',
      '31-60',
    ]);
    expect(list.groups.reduce((sum, g) => sum + g.total, 0)).toBe(list.total);
    expect(list.total).toBe(640000);
    expect(list.groups[0]?.total).toBe(40000);
  });

  it('filters and sorts customers, and exports the list CSV', async () => {
    const { db, ctx } = await setup('list');
    const a = await customer(db, 'Ali', '+923001234567');
    const b = await customer(db, 'Bilal', '');
    await createCustomerAccount(
      db,
      { name: 'Credit', phone: '', opening: 50000 },
      ctx,
      'st-1',
      NOW,
    );
    await udhaarSale(db, ctx, a.id, 300000);
    await receivePayment(
      db,
      {
        paymentId: 'overpay',
        customerId: b.id,
        amount: 10000,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 1000 },
    );
    const all = await customerList(db, { today: TODAY });
    expect(all.rows).toHaveLength(3);
    expect(
      (await customerList(db, { today: TODAY, filter: 'owes' })).rows.map(
        (r) => r.customer.name,
      ),
    ).toEqual(['Ali', 'Credit']);
    expect(
      (await customerList(db, { today: TODAY, filter: 'in_credit' })).rows.map(
        (r) => r.customer.name,
      ),
    ).toEqual(['Bilal']);
    expect(
      (await customerList(db, { today: TODAY, query: 'ali' })).rows,
    ).toHaveLength(1);
    expect(
      (await customerList(db, { today: TODAY, query: '3001234567' })).rows,
    ).toHaveLength(1);
    const csv = customersCsv(all.rows, TZ, NOW);
    expect(csv.split('\r\n')[0]).toBe(
      'name,phone,balance,oldest_unpaid_days,credit_limit,promise_on,last_activity',
    );
    expect(csv).toContain("Ali,'+923001234567,3000,0,");
    expect(all.receivedThisMonth).toBe(10000);
  });

  it('statement range keeps the balance before the range', async () => {
    const { db, ctx } = await setup('range');
    const ali = await customer(db);
    await udhaarSale(db, ctx, ali.id, 300000);
    await receivePayment(
      db,
      {
        paymentId: 'range-pay',
        customerId: ali.id,
        amount: 100000,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 1000 },
    );
    const statement = await customerStatement(db, ali.id, {
      from: TODAY,
      to: TODAY,
    });
    expect(statement.openingBalance).toBe(0);
    expect(statement.rows).toHaveLength(2);
    const csv = statementCsv(
      statement.rows.map((row) => ({
        date: String(row.entry.business_date),
        description: row.kind,
        debit: row.debit,
        credit: row.credit,
        balance: row.balance,
      })),
    );
    expect(csv.split('\r\n')[0]).toBe('date,description,debit,credit,balance');
  });

  it('receivePayment enforces dates, amounts and idempotency', async () => {
    const { db, ctx } = await setup('payments');
    const ali = await customer(db);
    await expect(
      receivePayment(
        db,
        {
          paymentId: newId(),
          customerId: ali.id,
          amount: 0,
          method: 'cash',
          date: TODAY,
        },
        ctx,
        { role: 'owner', today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'amount' });
    await expect(
      receivePayment(
        db,
        {
          paymentId: newId(),
          customerId: ali.id,
          amount: 100,
          method: 'cash',
          date: '2020-01-01',
        },
        ctx,
        { role: 'owner', today: TODAY, now: NOW },
      ),
    ).rejects.toBeInstanceOf(PaymentError);
    const cashierDate = businessDate(NOW - 86_400_000, TZ);
    await expect(
      receivePayment(
        db,
        {
          paymentId: newId(),
          customerId: ali.id,
          amount: 100,
          method: 'cash',
          date: cashierDate,
        },
        ctx,
        { role: 'cashier', today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'owner' });
    const first = await receivePayment(
      db,
      {
        paymentId: 'same-id',
        customerId: ali.id,
        amount: 100,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW },
    );
    const again = await receivePayment(
      db,
      {
        paymentId: 'same-id',
        customerId: ali.id,
        amount: 999,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 5 },
    );
    expect(again.id).toBe(first.id);
    expect(again.amount).toBe(100);
  });

  it('promises reject past dates and zero amounts', async () => {
    const { db } = await setup('promise-errors');
    const ali = await customer(db);
    await expect(
      createPromise(
        db,
        { customerId: ali.id, promisedOn: '2026-10-26', amount: null },
        'st-1',
        { today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'date' });
    await expect(
      createPromise(
        db,
        {
          customerId: ali.id,
          promisedOn: businessDate(NOW + 86_400_000, TZ),
          amount: 0,
        },
        'st-1',
        { today: TODAY, now: NOW },
      ),
    ).rejects.toBeInstanceOf(PromiseError);
  });

  it('creates, edits and deletes customers with a settled balance', async () => {
    const { db, ctx } = await setup('customer-edit');
    const ali = await customer(db);
    await expect(
      createCustomer(
        db,
        { name: 'Other', phone: '+923001234567' },
        'st-1',
        NOW,
      ),
    ).rejects.toBeInstanceOf(DuplicatePhoneError);
    const updated = await updateCustomer(
      db,
      ali.id,
      {
        name: 'Ali Raza',
        phone: '',
        address: 'Street 1',
        note: 'VIP',
        credit_limit: 500000,
        hard_limit: true,
      },
      ctx,
      NOW + 1000,
    );
    expect(updated).toMatchObject({
      name: 'Ali Raza',
      credit_limit: 500000,
      hard_limit: 1,
    });
    expect(
      await db.audit_log
        .where('[entity+entity_id]')
        .equals(['customers', ali.id])
        .toArray(),
    ).toMatchObject([{ action: 'credit_limit_change' }]);
    await createCustomerAccount(
      db,
      { name: 'Opening', phone: '', opening: 5000 },
      ctx,
      'st-1',
      NOW,
    );
    const opening = (await db.ledger_entries.toArray()).find(
      (e) => e.source_type === 'opening',
    );
    expect(opening).toMatchObject({ amount: 5000, party_type: 'customer' });
    await udhaarSale(db, ctx, ali.id, 100000);
    await expect(
      deleteCustomer(db, ali.id, 'st-1', NOW + 2000),
    ).rejects.toBeInstanceOf(CustomerBalanceError);
    await receivePayment(
      db,
      {
        paymentId: 'settle',
        customerId: ali.id,
        amount: 100000,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 3000 },
    );
    await deleteCustomer(db, ali.id, 'st-1', NOW + 4000);
    expect((await db.customers.get(ali.id))?.deleted_at).not.toBeNull();
  });
});

describe('udhaar branch coverage', () => {
  it('filters over limit and promises due, and sorts by age/activity', async () => {
    const { db, ctx } = await setup('filters');
    const ali = await customer(db, 'Ali', '');
    const bilal = await customer(db, 'Bilal', '');
    await udhaarSale(db, ctx, ali.id, 300000);
    await updateCustomer(
      db,
      ali.id,
      {
        name: 'Ali',
        phone: '',
        address: '',
        note: '',
        credit_limit: 100000,
        hard_limit: false,
      },
      ctx,
      NOW + 1000,
    );
    await createPromise(
      db,
      { customerId: bilal.id, promisedOn: TODAY, amount: null },
      'st-1',
      { today: TODAY, now: NOW },
    );
    expect(
      (await customerList(db, { today: TODAY, filter: 'over_limit' })).rows.map(
        (row) => row.customer.name,
      ),
    ).toEqual(['Ali']);
    expect(
      (
        await customerList(db, { today: TODAY, filter: 'promise_due' })
      ).rows.map((row) => row.customer.name),
    ).toEqual(['Bilal']);
    expect(
      (await customerList(db, { today: TODAY, sort: 'oldest' })).rows,
    ).toHaveLength(2);
    expect(
      (await customerList(db, { today: TODAY, sort: 'activity' })).rows,
    ).toHaveLength(2);
    const csv = customersCsv(
      (await customerList(db, { today: TODAY })).rows,
      TZ,
      NOW,
    );
    expect(csv).toContain('Ali,,3000');
    expect(csv).toContain('1000');
  });

  it('rejects invalid payment methods, missing customers and future dates', async () => {
    const { db, ctx } = await setup('payment-errors');
    const ali = await customer(db);
    await expect(
      receivePayment(
        db,
        {
          paymentId: newId(),
          customerId: ali.id,
          amount: 100,
          method: 'nope' as 'cash',
          date: TODAY,
        },
        ctx,
        { role: 'owner', today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'method' });
    await expect(
      receivePayment(
        db,
        {
          paymentId: newId(),
          customerId: 'missing',
          amount: 100,
          method: 'cash',
          date: TODAY,
        },
        ctx,
        { role: 'owner', today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'customer' });
    await expect(
      receivePayment(
        db,
        {
          paymentId: newId(),
          customerId: ali.id,
          amount: 100,
          method: 'cash',
          date: businessDate(NOW + 86_400_000, TZ),
        },
        ctx,
        { role: 'owner', today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'date' });
    await db.customers.update(ali.id, { deleted_at: NOW });
    await expect(
      receivePayment(
        db,
        {
          paymentId: newId(),
          customerId: ali.id,
          amount: 100,
          method: 'cash',
          date: TODAY,
        },
        ctx,
        { role: 'owner', today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'customer' });
  });

  it('handles promises for missing customers and refresh with nothing to do', async () => {
    const { db, ctx } = await setup('promise-missing');
    await expect(
      createPromise(
        db,
        {
          customerId: 'missing',
          promisedOn: TODAY,
          amount: null,
        },
        'st-1',
        { today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'customer' });
    expect(await refreshPromises(db, { today: TODAY, now: NOW })).toBe(0);
    const ali = await customer(db);
    await udhaarSale(db, ctx, ali.id, 100000);
    await createPromise(
      db,
      {
        customerId: ali.id,
        promisedOn: businessDate(NOW + 7 * 86_400_000, TZ),
        amount: null,
      },
      'st-1',
      { today: TODAY, now: NOW },
    );
    expect(await refreshPromises(db, { today: TODAY, now: NOW })).toBe(0);
  });

  it('statement shows refund, void and adjustment entries and a range opening', async () => {
    const { db, ctx } = await setup('statement-kinds');
    const ali = await customer(db);
    const product = await saveNewProduct(
      db,
      { name_en: 'Thing', price: 300000, opening_milli: 10000 },
      ctx,
      { now: NOW },
    );
    const cart = {
      ...addProduct(emptyCart('c1'), product, 1000, 'avg'),
      customer_id: ali.id,
    };
    const saleId = 'kinds-sale';
    await completeSale(
      db,
      sale(cart, [{ method: 'udhaar', amount: 300000 }], { saleId }),
      ctx,
      NOW,
    );
    const line = (await db.sale_lines
      .where('sale_id')
      .equals(saleId)
      .first()) as { id: string };
    await refundSale(
      db,
      {
        refundId: 'kinds-refund',
        saleId,
        lines: [{ saleLineId: line.id, qtyMilli: 1000, restock: false }],
        reason: 'Faulty',
        method: 'cash',
      },
      ctx,
      NOW + 1000,
    );
    const voidSaleId = 'kinds-void-sale';
    const voidCart = {
      ...addProduct(emptyCart('c2'), product, 1000, 'avg'),
      customer_id: ali.id,
    };
    await completeSale(
      db,
      sale(voidCart, [{ method: 'udhaar', amount: 300000 }], {
        saleId: voidSaleId,
      }),
      ctx,
      NOW + 2000,
    );
    await voidSale(
      db,
      { voidId: 'kinds-void', saleId: voidSaleId, reason: 'Wrong item' },
      ctx,
      NOW + 3000,
    );
    await db.ledger_entries.add({
      id: 'adjustment',
      party_type: 'customer',
      party_id: ali.id,
      amount: 5000,
      source_type: 'adjustment',
      source_id: null,
      note: 'Manual fix',
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW + 4000,
    });
    const statement = await customerStatement(db, ali.id);
    expect(statement.rows.map((row) => row.kind)).toEqual([
      'sale',
      'refund',
      'sale',
      'void',
      'adjustment',
    ]);
    expect(statement.rows[1]?.invoiceNo).toBe('A-A-1');
    expect(statement.rows[3]?.invoiceNo).toBeDefined();
    const later = await customerStatement(db, ali.id, {
      from: businessDate(NOW + 5 * 86_400_000, TZ),
      to: businessDate(NOW + 6 * 86_400_000, TZ),
    });
    expect(later.rows).toEqual([]);
    expect(later.openingBalance).toBe(5000);
    const chase = await chaseList(db, { today: TODAY, now: NOW });
    expect(chaseCsv(chase, (key) => key)).toContain('name,phone,balance');
    expect(reminderLink('not-a-phone', 'x')).toBeNull();
  });
});
