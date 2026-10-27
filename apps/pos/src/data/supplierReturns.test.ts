import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { jobReceipt } from '../print/receiptFiles.ts';
import { ledgerContext } from './catalog.ts';
import { expectedCash } from './reports.ts';
import {
  loadSupplierReturnReceipt,
  queueSupplierReturnPrint,
} from './supplierReturnReceipt.ts';
import {
  createSupplierReturn,
  planSupplierReturn,
  SupplierReturnError,
  supplierReturnData,
} from './supplierReturns.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const TZ = 'Asia/Karachi';
const TODAY = '2026-10-27';
const row = { created_at: NOW, updated_at: NOW, deleted_at: null, rev: 1 };

async function setup(prefix = 'returns') {
  const db = await readyDb(prefix);
  await addShop(db, { timezone: TZ });
  const ctx = await ledgerContext(db, 'st-1');
  await db.suppliers.add({
    ...row,
    id: 'sup-1',
    name: 'Ali Traders',
    phone: '',
    address: '',
    note: '',
  } as never);
  return { db, ctx };
}

function product(id: string, name: string, avg: number, stock: number) {
  return {
    ...row,
    id,
    name_en: name,
    name_ur: '',
    sku: id.toUpperCase(),
    brand: '',
    category_id: null,
    unit: 'pc',
    price: avg * 2,
    last_cost: avg,
    avg_cost: avg,
    min_stock_milli: 0,
    track_stock: 1,
    tax_rate_bp: null,
    track_serial: 0,
    warranty_days: 0,
    pack_size_milli: null,
    image_key: null,
    notes: '',
    on_hand_milli: stock,
  };
}

async function openingBalance(
  db: Awaited<ReturnType<typeof readyDb>>,
  amount: number,
) {
  await db.ledger_entries.add({
    id: `opening-${amount}`,
    party_type: 'supplier',
    party_id: 'sup-1',
    amount,
    source_type: 'opening',
    source_id: '',
    note: '',
    created_at: NOW - 1000,
  } as SyncedRow);
  await db.party_balances.put({
    party_type: 'supplier',
    party_id: 'sup-1',
    balance: amount,
    last_activity_at: NOW - 1000,
    oldest_unpaid_at: amount > 0 ? NOW - 1000 : null,
  });
}

async function purchaseLine(
  db: Awaited<ReturnType<typeof readyDb>>,
  id: string,
  productId: string,
  landed: number,
) {
  await db.purchases.add({
    id: 'pur-1',
    supplier_id: 'sup-1',
    supplier_invoice_no: 'SUP-1',
    other_charges: 0,
    total: 240000,
    paid_now: 0,
    paid_method: null,
    line_count: 1,
    note: '',
    branch_id: 'br-1',
    device_id: 'dev-1',
    staff_id: 'st-1',
    business_date: TODAY,
    created_at: NOW,
  } as SyncedRow);
  await db.purchase_lines.add({
    id,
    purchase_id: 'pur-1',
    line_no: 1,
    product_id: productId,
    qty_milli: 2000,
    unit_cost: landed,
    line_total: 240000,
    charges_alloc: 0,
    landed_unit_cost: landed,
    created_at: NOW,
  } as SyncedRow);
}

describe('return to supplier (screens/13 ACs 6–8, 07 §10)', () => {
  it('S1: credits the landed cost, removes stock and keeps the average', async () => {
    const { db, ctx } = await setup();
    const { on_hand_milli: _ignored, ...p } = product(
      'charger',
      'Charger',
      112000,
      5000,
    );
    await db.products.add(p as never);
    await db.stock_levels.put({ product_id: 'charger', on_hand_milli: 5000 });
    await purchaseLine(db, 'pl-1', 'charger', 120000);
    await openingBalance(db, 6000000);
    const input = {
      supplierId: 'sup-1',
      purchaseId: 'pur-1',
      lines: [
        {
          productId: 'charger',
          purchaseLineId: 'pl-1',
          qtyMilli: 2000,
        },
      ],
      reason: 'Faulty',
      refundReceived: 0,
      refundMethod: null,
    };
    const plan = await planSupplierReturn(db, input);
    expect(plan).toMatchObject({
      total: 240000,
      suggestedRefund: 0,
      balanceBefore: 6000000,
      balanceAfter: 5760000,
    });
    const returned = await createSupplierReturn(
      db,
      { ...input, returnId: 'ret-s1' },
      ctx,
      { now: NOW, today: TODAY },
    );
    expect(returned).toMatchObject({ total: 240000, line_count: 1 });
    const lines = await db.supplier_return_lines.toArray();
    expect(lines[0]).toMatchObject({
      unit_credit: 120000,
      line_total: 240000,
      cost_snapshot: 112000,
    });
    expect((await db.stock_levels.get('charger'))?.on_hand_milli).toBe(3000);
    expect((await db.products.get('charger'))?.avg_cost).toBe(112000);
    expect((await db.party_balances.get(['supplier', 'sup-1']))?.balance).toBe(
      5760000,
    );
    const difference = 240000 - 2 * 112000;
    expect(difference).toBe(16000);
    const receipt = await loadSupplierReturnReceipt(db, 'ret-s1');
    expect(receipt).toMatchObject({
      supplierName: 'Ali Traders',
      total: 240000,
      purchaseInvoice: 'SUP-1',
    });
    const printId = await queueSupplierReturnPrint(db, 'ret-s1', NOW + 2);
    const job = await db.print_jobs.get(printId);
    expect(job ? await jobReceipt(db, job) : null).not.toBeNull();
    const again = await createSupplierReturn(
      db,
      { ...input, returnId: 'ret-s1' },
      ctx,
      { now: NOW + 1000, today: TODAY },
    );
    expect(again).toEqual(returned);
  });

  it('S2: no linked delivery, supplier pays Rs 550 cash and day close sees it', async () => {
    const { db, ctx } = await setup('s2');
    const { on_hand_milli: _ignored, ...p } = product(
      'cable',
      'Cable',
      35000,
      10000,
    );
    await db.products.add(p as never);
    await db.stock_levels.put({ product_id: 'cable', on_hand_milli: 10000 });
    await openingBalance(db, 50000);
    const plan = await planSupplierReturn(db, {
      supplierId: 'sup-1',
      lines: [{ productId: 'cable', qtyMilli: 3000 }],
      reason: 'Unsold',
      refundReceived: 55000,
      refundMethod: 'cash',
    });
    expect(plan).toMatchObject({
      total: 105000,
      suggestedRefund: 55000,
      balanceAfter: 0,
    });
    await createSupplierReturn(
      db,
      {
        returnId: 'ret-s2',
        supplierId: 'sup-1',
        lines: [{ productId: 'cable', qtyMilli: 3000 }],
        reason: 'Unsold',
        refundReceived: 55000,
        refundMethod: 'cash',
      },
      ctx,
      { now: NOW, today: TODAY },
    );
    expect((await db.party_balances.get(['supplier', 'sup-1']))?.balance).toBe(
      0,
    );
    const payments = await db.payments.toArray();
    expect(payments.find((p) => p.purpose === 'supplier_refund')).toMatchObject(
      { amount: 55000, method: 'cash', direction: 'in' },
    );
    expect(await expectedCash(db, 'dev-1', NOW + 1)).toBe(55000);
  });

  it('S3: leaves a Rs 36,200 advance with no cash received', async () => {
    const { db, ctx } = await setup('s3');
    const { on_hand_milli: _ignored, ...p } = product(
      'phone',
      'Phone',
      3600000,
      1000,
    );
    await db.products.add(p as never);
    await db.stock_levels.put({ product_id: 'phone', on_hand_milli: 1000 });
    await openingBalance(db, -20000);
    const plan = await planSupplierReturn(db, {
      supplierId: 'sup-1',
      lines: [{ productId: 'phone', qtyMilli: 1000 }],
      reason: 'Unsold',
      refundReceived: 0,
      refundMethod: null,
    });
    expect(plan).toMatchObject({
      total: 3600000,
      suggestedRefund: 3600000,
      balanceBefore: -20000,
      balanceAfter: -3620000,
    });
    await createSupplierReturn(
      db,
      {
        returnId: 'ret-s3',
        supplierId: 'sup-1',
        lines: [{ productId: 'phone', qtyMilli: 1000 }],
        reason: 'Unsold',
        refundReceived: 0,
        refundMethod: null,
      },
      ctx,
      { now: NOW + 1, today: TODAY },
    );
    expect((await db.party_balances.get(['supplier', 'sup-1']))?.balance).toBe(
      -3620000,
    );
    expect(await db.payments.count()).toBe(0);
  });

  it('lists remaining delivery quantities and rejects invalid input', async () => {
    const { db, ctx } = await setup('validation');
    const { on_hand_milli: _ignored, ...p } = product(
      'charger',
      'Charger',
      112000,
      0,
    );
    await db.products.add(p as never);
    await purchaseLine(db, 'pl-1', 'charger', 120000);
    const data = await supplierReturnData(db, 'sup-1', TODAY);
    expect(data?.purchases[0]?.lines[0]).toMatchObject({
      received: 2000,
      returned: 0,
      remaining: 2000,
      landedCost: 120000,
    });
    await createSupplierReturn(
      db,
      {
        returnId: 'ret-part',
        supplierId: 'sup-1',
        purchaseId: 'pur-1',
        lines: [
          {
            productId: 'charger',
            purchaseLineId: 'pl-1',
            qtyMilli: 1000,
          },
        ],
        reason: 'Faulty',
        refundReceived: 0,
        refundMethod: null,
      },
      ctx,
      { now: NOW, today: TODAY },
    );
    const after = await supplierReturnData(db, 'sup-1', TODAY);
    expect(after?.purchases[0]?.lines[0]?.remaining).toBe(1000);
    await expect(
      planSupplierReturn(db, {
        supplierId: 'missing',
        lines: [{ productId: 'charger', qtyMilli: 1000 }],
        reason: 'Faulty',
        refundReceived: 0,
        refundMethod: null,
      }),
    ).rejects.toMatchObject({ code: 'supplier' });
    await expect(
      planSupplierReturn(db, {
        supplierId: 'sup-1',
        lines: [],
        reason: 'Faulty',
        refundReceived: 0,
        refundMethod: null,
      }),
    ).rejects.toMatchObject({ code: 'lines' });
    await expect(
      planSupplierReturn(db, {
        supplierId: 'sup-1',
        lines: [{ productId: 'charger', qtyMilli: 0 }],
        reason: 'Faulty',
        refundReceived: 0,
        refundMethod: null,
      }),
    ).rejects.toBeInstanceOf(SupplierReturnError);
    await expect(
      planSupplierReturn(db, {
        supplierId: 'sup-1',
        lines: [{ productId: 'charger', qtyMilli: 1000 }],
        reason: '',
        refundReceived: 0,
        refundMethod: null,
      }),
    ).rejects.toMatchObject({ code: 'reason' });
  });
});
