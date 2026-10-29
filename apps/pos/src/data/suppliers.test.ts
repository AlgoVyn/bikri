import { businessDate } from '@bikri/core';
import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import {
  DeliveryError,
  paySupplier,
  SupplierPaymentError,
  saveDelivery,
} from './purchases.ts';
import { expectedCash } from './reports.ts';
import {
  createSupplier,
  deleteSupplier,
  SupplierBalanceError,
  supplierBalance,
  supplierList,
  supplierStatement,
  supplierStatementCsv,
  suppliersCsv,
  updateSupplier,
} from './suppliers.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const TZ = 'Asia/Karachi';
const TODAY = businessDate(NOW, TZ);

async function setup(prefix = 'supplier') {
  const db = await readyDb(prefix);
  await addShop(db, { name: 'Bikri', timezone: TZ });
  const ctx = await ledgerContext(db, 'st-1');
  return { db, ctx };
}

async function product(
  db: Awaited<ReturnType<typeof readyDb>>,
  ctx: Awaited<ReturnType<typeof ledgerContext>>,
  name = 'Phone',
  cost = 110000,
) {
  return saveNewProduct(
    db,
    { name_en: name, price: 300000, cost, opening_milli: 20000 },
    ctx,
    { now: NOW },
  );
}

describe('suppliers and deliveries (T-045)', () => {
  it('AC 1: receiving 5 @ 1,200 on 20 @ 1,100 gives 25 on hand, avg 1,120 and last cost 1,200', async () => {
    const { db, ctx } = await setup();
    const item = await product(db, ctx);
    const supplier = await createSupplier(
      db,
      { name: 'Hall Road' },
      ctx,
      'st-1',
      NOW,
    );
    const purchaseId = 'delivery-1';
    const purchase = await saveDelivery(
      db,
      {
        purchaseId,
        supplierId: supplier.id,
        invoiceNo: 'SUP-552',
        date: TODAY,
        lines: [{ productId: item.id, qtyMilli: 5000, unitCost: 120000 }],
        otherCharges: 0,
        paidNow: 0,
      },
      ctx,
      { today: TODAY, now: NOW + 1000 },
    );
    expect(purchase).toMatchObject({
      total: 600000,
      line_count: 1,
      paid_now: 0,
      paid_method: null,
    });
    const [line] = await db.purchase_lines.toArray();
    expect(line).toMatchObject({
      line_total: 600000,
      charges_alloc: 0,
      landed_unit_cost: 120000,
    });
    const fresh = await db.products.get(item.id);
    expect(fresh).toMatchObject({ avg_cost: 112000, last_cost: 120000 });
    expect((await db.stock_levels.get(item.id))?.on_hand_milli).toBe(25000);
    expect(
      (await db.stock_movements.toArray()).find(
        (m) => m.reason_code === 'purchase',
      ),
    ).toMatchObject({ qty_delta_milli: 5000, unit_cost: 120000 });
    expect(await supplierBalance(db, supplier.id)).toBe(600000);
    expect((await supplierStatement(db, supplier.id)).rows).toMatchObject([
      {
        kind: 'purchase',
        invoiceNo: 'SUP-552',
        lineCount: 1,
        got: 600000,
        balance: 600000,
      },
    ]);
  });

  it('AC 2/3: paid now 5,500 cash is a supplier payment and reduces the balance and expected cash', async () => {
    const { db, ctx } = await setup('paid');
    const item = await product(db, ctx);
    const supplier = await createSupplier(
      db,
      { name: 'Hall Road' },
      ctx,
      'st-1',
      NOW,
    );
    await saveDelivery(
      db,
      {
        purchaseId: 'delivery-paid',
        supplierId: supplier.id,
        date: TODAY,
        lines: [{ productId: item.id, qtyMilli: 5000, unitCost: 120000 }],
        otherCharges: 0,
        paidNow: 550000,
        paidMethod: 'cash',
      },
      ctx,
      { today: TODAY, now: NOW + 1000 },
    );
    const payment = (await db.payments.toArray()).find(
      (p) => p.purpose === 'purchase_paid_now',
    );
    expect(payment).toMatchObject({
      direction: 'out',
      method: 'cash',
      amount: 550000,
      party_type: 'supplier',
      party_id: supplier.id,
    });
    expect(await supplierBalance(db, supplier.id)).toBe(50000);
    const expected = await expectedCash(db, 'dev-1', NOW + 2000);
    expect(expected).toBe(-550000);
    const fresh = await db.products.get(item.id);
    expect(fresh?.avg_cost).toBe(112000);
    expect(await supplierList(db)).toMatchObject({
      totalOwed: 50000,
      rows: [{ balance: 50000 }],
    });
  });

  it('AC 5: freight 300 splits 200/100 by line total and lands in each line', async () => {
    const { db, ctx } = await setup('freight');
    const a = await product(db, ctx, 'A', 100000);
    const b = await product(db, ctx, 'B', 100000);
    const supplier = await createSupplier(
      db,
      { name: 'Freight Co' },
      ctx,
      'st-1',
      NOW,
    );
    await saveDelivery(
      db,
      {
        purchaseId: 'delivery-freight',
        supplierId: supplier.id,
        date: TODAY,
        lines: [
          { productId: a.id, qtyMilli: 6000, unitCost: 100000 },
          { productId: b.id, qtyMilli: 3000, unitCost: 100000 },
        ],
        otherCharges: 30000,
        paidNow: 0,
      },
      ctx,
      { today: TODAY, now: NOW + 1000 },
    );
    const lines = (await db.purchase_lines.toArray()).sort(
      (a, b) => Number(a.line_no) - Number(b.line_no),
    );
    expect(lines).toMatchObject([
      { charges_alloc: 20000, landed_unit_cost: 103333 },
      { charges_alloc: 10000, landed_unit_cost: 103333 },
    ]);
    const purchase = (await db.purchases.toArray())[0];
    expect(purchase).toMatchObject({ total: 930000, other_charges: 30000 });
  });

  it('averages duplicate product lines in order and accepts a zero-total delivery', async () => {
    const { db, ctx } = await setup('dupes');
    const item = await saveNewProduct(
      db,
      { name_en: 'Free sample', price: 100000, cost: 0, opening_milli: 0 },
      ctx,
      { now: NOW },
    );
    const supplier = await createSupplier(
      db,
      { name: 'Dup Co' },
      ctx,
      'st-1',
      NOW,
    );
    await saveDelivery(
      db,
      {
        purchaseId: 'delivery-dupes',
        supplierId: supplier.id,
        date: TODAY,
        lines: [
          { productId: item.id, qtyMilli: 1000, unitCost: 100 },
          { productId: item.id, qtyMilli: 1000, unitCost: 300 },
        ],
        otherCharges: 0,
        paidNow: 0,
      },
      ctx,
      { today: TODAY, now: NOW + 1000 },
    );
    expect(await db.products.get(item.id)).toMatchObject({
      avg_cost: 200,
      last_cost: 300,
    });
    expect((await db.stock_levels.get(item.id))?.on_hand_milli).toBe(2000);

    const free = await saveDelivery(
      db,
      {
        purchaseId: 'delivery-free',
        supplierId: supplier.id,
        date: TODAY,
        lines: [{ productId: item.id, qtyMilli: 1000, unitCost: 0 }],
        otherCharges: 0,
        paidNow: 0,
      },
      ctx,
      { today: TODAY, now: NOW + 2000 },
    );
    expect(free.total).toBe(0);
    expect(
      await db.ledger_entries
        .filter((row) => row.source_id === 'delivery-free')
        .count(),
    ).toBe(0);
    expect(
      await db.stock_movements
        .filter((row) => row.ref_id === 'delivery-free')
        .count(),
    ).toBe(1);
  });

  it('AC 4: no supplier expense category exists', async () => {
    const { db } = await setup('categories');
    expect(
      (await db.expense_categories.toArray()).some((c) =>
        /supplier/i.test(`${String(c.code)} ${String(c.name_en)}`),
      ),
    ).toBe(false);
  });

  it('pays a supplier, keeps the ledger and CSV headers', async () => {
    const { db, ctx } = await setup('pay');
    const supplier = await createSupplier(
      db,
      { name: 'Hall Road', phone: '03001234567', opening: 2000000 },
      ctx,
      'st-1',
      NOW,
    );
    await paySupplier(
      db,
      {
        paymentId: 'pay-supplier',
        supplierId: supplier.id,
        amount: 500000,
        method: 'cash',
        reference: 'TX1',
      },
      ctx,
      NOW + 1000,
    );
    expect(await supplierBalance(db, supplier.id)).toBe(1500000);
    const [supplierRow] = (await supplierList(db)).rows;
    expect(suppliersCsv([supplierRow] as never, TZ).split('\r\n')[0]).toBe(
      'name,phone,balance,last_delivery',
    );
    const statement = await supplierStatement(db, supplier.id);
    expect(statement.rows.map((r) => r.kind)).toEqual(['opening', 'payment']);
    expect(
      supplierStatementCsv(
        statement.rows.map((r) => ({
          date: String(r.entry.business_date),
          description: r.kind,
          got: r.got,
          paid: r.paid,
          balance: r.balance,
        })),
      ).split('\r\n')[0],
    ).toBe('date,description,got,paid,balance');
    expect(await db.payments.count()).toBe(1);
  });

  it('validates deliveries and payments', async () => {
    const { db, ctx } = await setup('errors');
    const item = await product(db, ctx);
    const supplier = await createSupplier(db, { name: 'S' }, ctx, 'st-1', NOW);
    const base = {
      purchaseId: 'bad',
      supplierId: supplier.id,
      date: TODAY,
      lines: [{ productId: item.id, qtyMilli: 1000, unitCost: 1000 }],
      otherCharges: 0,
      paidNow: 0,
    };
    await expect(
      saveDelivery(db, { ...base, lines: [] }, ctx, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'lines' });
    await expect(
      saveDelivery(db, { ...base, date: '2020-01-01' }, ctx, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'date' });
    await expect(
      saveDelivery(db, { ...base, paidNow: 999999 }, ctx, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'paid' });
    await expect(
      saveDelivery(db, { ...base, paidNow: 100, paidMethod: null }, ctx, {
        today: TODAY,
      }),
    ).rejects.toMatchObject({ code: 'method' });
    await expect(
      saveDelivery(db, { ...base, supplierId: 'missing' }, ctx, {
        today: TODAY,
      }),
    ).rejects.toMatchObject({ code: 'supplier' });
    await expect(
      saveDelivery(
        db,
        {
          ...base,
          lines: [{ productId: 'missing', qtyMilli: 1000, unitCost: 1000 }],
        },
        ctx,
        { today: TODAY },
      ),
    ).rejects.toMatchObject({ code: 'product' });
    const priceLines = Array.from({ length: 60 }, () => ({
      productId: item.id,
      qtyMilli: 1000,
      unitCost: 1000,
      updatePrice: 999999,
    }));
    await expect(
      saveDelivery(db, { ...base, lines: priceLines }, ctx, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'too_many' });
    // Without price changes the same 60 lines stay inside the per-action op budget.
    const plainLines = priceLines.map(({ updatePrice, ...line }) => line);
    await expect(
      saveDelivery(
        db,
        { ...base, purchaseId: 'many', lines: plainLines },
        ctx,
        { today: TODAY },
      ),
    ).resolves.toMatchObject({ line_count: 60 });

    await expect(
      paySupplier(
        db,
        { paymentId: 'x', supplierId: supplier.id, amount: 0, method: 'cash' },
        ctx,
        NOW,
      ),
    ).rejects.toBeInstanceOf(SupplierPaymentError);
    await expect(
      paySupplier(
        db,
        { paymentId: 'x', supplierId: 'missing', amount: 100, method: 'cash' },
        ctx,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'supplier' });
    const delivery = await saveDelivery(
      db,
      { ...base, purchaseId: 'ok' },
      ctx,
      {
        today: TODAY,
        now: NOW + 1000,
      },
    );
    const again = await saveDelivery(db, { ...base, purchaseId: 'ok' }, ctx, {
      today: TODAY,
      now: NOW + 2000,
    });
    expect(again.id).toBe(delivery.id);
    const paid = await paySupplier(
      db,
      {
        paymentId: 'same',
        supplierId: supplier.id,
        amount: 100,
        method: 'cash',
      },
      ctx,
      NOW + 3000,
    );
    const paidAgain = await paySupplier(
      db,
      {
        paymentId: 'same',
        supplierId: supplier.id,
        amount: 999,
        method: 'cash',
      },
      ctx,
      NOW + 4000,
    );
    expect(paidAgain.id).toBe(paid.id);
    expect(paidAgain.amount).toBe(100);
    await expect(
      deleteSupplier(db, supplier.id, 'st-1', NOW + 5000),
    ).rejects.toBeInstanceOf(SupplierBalanceError);
  });

  it('updates and soft-deletes a settled supplier', async () => {
    const { db, ctx } = await setup('edit');
    const supplier = await createSupplier(
      db,
      { name: 'Edit Me' },
      ctx,
      'st-1',
      NOW,
    );
    expect(
      await updateSupplier(
        db,
        supplier.id,
        { name: 'Edited', phone: '03001234567', address: 'A', note: 'N' },
        'st-1',
        NOW + 1000,
      ),
    ).toMatchObject({ name: 'Edited', phone: '03001234567' });
    await deleteSupplier(db, supplier.id, 'st-1', NOW + 2000);
    expect((await db.suppliers.get(supplier.id))?.deleted_at).not.toBeNull();
  });
});

describe('supplier branches', () => {
  it('covers search, price updates, invoices, returns and invalid lines', async () => {
    const { db, ctx } = await setup('branches');
    const item = await product(db, ctx, 'Item', 100000);
    const supplier = await createSupplier(
      db,
      { name: 'Search Me', phone: '03001234567' },
      ctx,
      'st-1',
      NOW,
    );
    expect((await supplierList(db, { query: 'search' })).rows).toHaveLength(1);
    expect((await supplierList(db, { query: '3001234567' })).rows).toHaveLength(
      1,
    );
    expect((await supplierList(db, { query: 'nope' })).rows).toEqual([]);
    const base = {
      purchaseId: 'branch-delivery',
      supplierId: supplier.id,
      date: TODAY,
      lines: [{ productId: item.id, qtyMilli: 1000, unitCost: 100000 }],
      otherCharges: 0,
      paidNow: 0,
    };
    await expect(
      saveDelivery(
        db,
        { ...base, date: businessDate(NOW + 2 * 86_400_000, TZ) },
        ctx,
        { today: TODAY },
      ),
    ).rejects.toMatchObject({ code: 'date' });
    await expect(
      saveDelivery(
        db,
        {
          ...base,
          lines: [{ productId: item.id, qtyMilli: 0, unitCost: 1000 }],
        },
        ctx,
        { today: TODAY },
      ),
    ).rejects.toMatchObject({ code: 'qty' });
    await expect(
      saveDelivery(
        db,
        {
          ...base,
          lines: [{ productId: item.id, qtyMilli: 1000, unitCost: -1 }],
        },
        ctx,
        { today: TODAY },
      ),
    ).rejects.toMatchObject({ code: 'cost' });
    await expect(
      saveDelivery(
        db,
        {
          ...base,
          lines: [
            {
              productId: item.id,
              qtyMilli: 1000,
              unitCost: 1000,
              updatePrice: -1,
            },
          ],
        },
        ctx,
        { today: TODAY },
      ),
    ).rejects.toMatchObject({ code: 'price' });
    await expect(
      saveDelivery(db, { ...base, paidNow: 0, paidMethod: 'cash' }, ctx, {
        today: TODAY,
      }),
    ).rejects.toMatchObject({ code: 'method' });
    await saveDelivery(
      db,
      {
        ...base,
        purchaseId: 'branch-price',
        invoiceNo: '',
        lines: [
          {
            productId: item.id,
            qtyMilli: 1000,
            unitCost: 100000,
            updatePrice: 350000,
          },
        ],
      },
      ctx,
      { today: TODAY, now: NOW + 1000 },
    );
    expect((await db.products.get(item.id))?.price).toBe(350000);
    expect(
      (await db.audit_log.toArray()).some((a) => a.action === 'price_change'),
    ).toBe(true);

    const [purchase] = await db.purchases.toArray();
    const returnId = 'supplier-return-1';
    await db.supplier_returns.add({
      id: returnId,
      supplier_id: supplier.id,
      purchase_id: purchase?.id ?? '',
      reason: 'Faulty',
      total: 10000,
      refund_received: 5000,
      refund_method: 'cash',
      line_count: 1,
      note: '',
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW + 2000,
    });
    const refundId = 'supplier-refund-1';
    await db.payments.add({
      id: refundId,
      direction: 'in',
      method: 'cash',
      purpose: 'supplier_refund',
      amount: 5000,
      cash_tendered: null,
      change_given: null,
      reference: '',
      sale_id: null,
      refund_id: null,
      purchase_id: null,
      supplier_return_id: returnId,
      party_type: 'supplier',
      party_id: supplier.id,
      note: '',
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW + 3000,
    });
    await db.ledger_entries.add({
      id: 'return-ledger',
      party_type: 'supplier',
      party_id: supplier.id,
      amount: -10000,
      source_type: 'supplier_return',
      source_id: returnId,
      note: '',
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW + 2000,
    });
    await db.ledger_entries.add({
      id: 'refund-ledger',
      party_type: 'supplier',
      party_id: supplier.id,
      amount: 5000,
      source_type: 'payment',
      source_id: refundId,
      note: '',
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW + 3000,
    });
    const statement = await supplierStatement(db, supplier.id);
    expect(statement.rows.map((r) => r.kind)).toEqual([
      'purchase',
      'return',
      'refund',
    ]);
    expect(statement.rows[1]).toMatchObject({
      reason: 'Faulty',
      lineCount: 1,
      paid: 10000,
    });
    expect(statement.rows[2]).toMatchObject({ kind: 'refund', got: 5000 });
  });
});
