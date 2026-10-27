import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import { createCustomer } from './customers.ts';
import {
  billDetail,
  rangeFor,
  salesCsv,
  salesHistory,
  shopTimeZone,
} from './salesHistory.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const base = {
  branch_id: 'br-1',
  device_id: 'dev-1',
  staff_id: 'st-1',
  business_date: '2026-10-27',
  created_at: NOW,
  line_count: 1,
  items_qty_milli: 1000,
  gross_total: 10000,
  item_discount_total: 0,
  subtotal: 10000,
  bill_discount_type: null,
  bill_discount_value: 0,
  bill_discount: 0,
  tax_rate_bp: 0,
  tax: 0,
  tax_inclusive: 0,
  rounding: 0,
  total: 10000,
  paid_total: 10000,
  udhaar_amount: 0,
  cash_tendered: 10000,
  change_given: 0,
  status: 'paid',
  replaces_sale_id: null,
  note: '',
};

function saleRow(id: string, over: Record<string, unknown> = {}): SyncedRow {
  return {
    ...base,
    id,
    invoice_no: `A-A-${id}`,
    invoice_seq: 1,
    ...over,
  } as SyncedRow;
}

function lineRow(
  id: string,
  saleId: string,
  over: Record<string, unknown> = {},
): SyncedRow {
  return {
    id,
    sale_id: saleId,
    line_no: 1,
    product_id: null,
    name_snapshot: 'Item',
    sku_snapshot: '',
    qty_milli: 1000,
    unit_price: 10000,
    gross: 10000,
    discount_type: null,
    discount_value: 0,
    discount: 0,
    net: 10000,
    bill_discount_alloc: 0,
    tax_alloc: 0,
    rounding_alloc: 0,
    unit_cost_snapshot: 0,
    below_cost: 0,
    serial: null,
    warranty_until: null,
    created_at: NOW,
    ...over,
  } as SyncedRow;
}

function paymentRow(
  id: string,
  saleId: string,
  over: Record<string, unknown> = {},
): SyncedRow {
  return {
    ...base,
    id,
    direction: 'in',
    method: 'cash',
    purpose: 'sale',
    amount: 5000,
    cash_tendered: null,
    change_given: null,
    reference: '',
    sale_id: saleId,
    refund_id: null,
    purchase_id: null,
    supplier_return_id: null,
    party_type: null,
    party_id: null,
    note: '',
    created_at: NOW,
    ...over,
  } as SyncedRow;
}

async function rawHistory() {
  const db = await readyDb('cov');
  await addShop(db, { timezone: 'Asia/Karachi' });
  const ctx = await ledgerContext(db, 'st-1');
  const cable = await saveNewProduct(
    db,
    { name_en: 'Cable', sku: 'SKU-COV-1', price: 10000, opening_milli: 5000 },
    ctx,
    { now: NOW },
  );
  const labour = await saveNewProduct(
    db,
    { name_en: 'Labour', price: 5000, track_stock: false },
    ctx,
    { now: NOW },
  );
  const ali = await createCustomer(
    db,
    { name: 'Ali', phone: '+923001234567' },
    'st-1',
    NOW,
  );
  const gone = await createCustomer(
    db,
    { name: 'Gone', phone: '+923009999999' },
    'st-1',
    NOW,
  );
  await db.customers.update(gone.id, { deleted_at: NOW });

  await db.sales.bulkAdd([
    saleRow('s1', { total: 10000, paid_total: 10000 }),
    saleRow('s2', {
      customer_id: ali.id,
      total: 5000,
      paid_total: 0,
      udhaar_amount: 5000,
      cash_tendered: 0,
      created_at: NOW + 1,
    }),
    saleRow('s3', {
      device_id: 'unknown',
      created_at: NOW + 2,
    }),
    saleRow('s4', { status: 'void', created_at: NOW + 3 }),
    saleRow('s5', {
      branch_id: '',
      device_id: '',
      staff_id: 'missing',
      created_at: NOW + 4,
    }),
    saleRow('s6', {
      customer_id: gone.id,
      total: 5000,
      created_at: NOW + 5,
    }),
  ]);
  await db.sale_lines.bulkAdd([
    lineRow('l1', 's1', {
      product_id: cable.id,
      sku_snapshot: 'SKU-COV-1',
      qty_milli: 1000,
      net: 10000,
    }),
    lineRow('l2', 's2', {
      product_id: labour.id,
      name_snapshot: 'Labour',
      qty_milli: 1000,
      net: 5000,
      unit_price: 5000,
    }),
    lineRow('l3', 's3', { name_snapshot: 'Quick sale', net: 10000 }),
    lineRow('l4', 's5', { name_snapshot: 'Cable 2' }),
    lineRow('l5', 's6', { name_snapshot: 'Cable 3', net: 5000 }),
  ]);
  await db.payments.bulkAdd([
    paymentRow('p1', 's1', { method: 'cash', amount: 5000 }),
    paymentRow('p2', 's1', {
      method: 'card',
      amount: 5000,
      created_at: NOW + 1,
    }),
    paymentRow('p3', 's5', { amount: 10000 }),
  ]);
  return { db, cable, labour, ali, gone };
}

describe('back-office branch coverage', () => {
  it('rangeFor covers every preset and the custom fallback', () => {
    const tz = 'Asia/Karachi';
    expect(rangeFor('today', NOW, tz)).toEqual({
      from: '2026-10-27',
      to: '2026-10-27',
    });
    expect(rangeFor('yesterday', NOW, tz)).toEqual({
      from: '2026-10-26',
      to: '2026-10-26',
    });
    expect(rangeFor('7d', NOW, tz)).toEqual({
      from: '2026-10-21',
      to: '2026-10-27',
    });
    expect(rangeFor('30d', NOW, tz)).toEqual({
      from: '2026-09-28',
      to: '2026-10-27',
    });
    expect(rangeFor('month', NOW, tz)).toEqual({
      from: '2026-10-01',
      to: '2026-10-27',
    });
    expect(
      rangeFor('custom', NOW, tz, { from: '2026-01-01', to: '2026-01-02' }),
    ).toEqual({ from: '2026-01-01', to: '2026-01-02' });
    expect(rangeFor('custom', NOW, tz)).toEqual({
      from: '2026-10-27',
      to: '2026-10-27',
    });
  });

  it('shopTimeZone falls back to Karachi for a blank time zone', async () => {
    const db = await readyDb('tz');
    await addShop(db, { timezone: '' });
    expect(await shopTimeZone(db)).toBe('Asia/Karachi');
    await addShop(db, { timezone: 'UTC' });
    expect(await shopTimeZone(db)).toBe('UTC');
  });

  it('lists split and udhaar methods, filters, searches and failed prints', async () => {
    const { db } = await rawHistory();
    const day = { from: '2026-10-27', to: '2026-10-27' };
    const all = await salesHistory(db, day);
    expect(all.rows).toHaveLength(6);
    expect(all.rows.find((r) => r.sale.id === 's1')?.methods).toEqual([
      'cash',
      'card',
    ]);
    expect(all.rows.find((r) => r.sale.id === 's2')?.methods).toEqual([
      'udhaar',
    ]);
    expect(all.rows.find((r) => r.sale.id === 's2')?.customerName).toBe('Ali');
    expect(
      (await salesHistory(db, { ...day, method: 'split' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s1']);
    expect(
      (await salesHistory(db, { ...day, method: 'udhaar' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s2']);
    expect(
      (await salesHistory(db, { ...day, method: 'card' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s1']);
    expect(
      (await salesHistory(db, { ...day, status: 'void' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s4']);
    expect(
      (await salesHistory(db, { ...day, branchId: 'br-1' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s6', 's4', 's3', 's2', 's1']);
    expect(
      (await salesHistory(db, { ...day, staffId: 'missing' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s5']);
    expect(
      (await salesHistory(db, { ...day, deviceId: 'unknown' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s3']);
    expect(
      (await salesHistory(db, { ...day, query: '3001234567' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s2']);
    expect(
      (await salesHistory(db, { ...day, query: 'SKU-COV-1' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s1']);
    expect(
      (await salesHistory(db, { ...day, query: 'labour' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s2']);
    expect((await salesHistory(db, { ...day, query: 'gone' })).rows).toEqual(
      [],
    );
    expect(
      (await salesHistory(db, { ...day, query: 'A-A-s3' })).rows.map(
        (r) => r.sale.id,
      ),
    ).toEqual(['s3']);

    // Device names come from the pulled device row, with the local kv as a fallback.
    expect(
      (await salesHistory(db, day)).rows.find((r) => r.sale.id === 's1')
        ?.deviceName,
    ).toBe('Counter 1');
    await db.devices.add({
      id: 'dev-1',
      name: 'Counter 2',
      code: 'A',
      branch_id: 'br-1',
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      rev: 1,
    });
    expect(
      (await salesHistory(db, day)).rows.find((r) => r.sale.id === 's1')
        ?.deviceName,
    ).toBe('Counter 2');
    expect(
      (await salesHistory(db, day)).rows.find((r) => r.sale.id === 's3')
        ?.deviceName,
    ).toBe('');

    // A failed job stays red until a later job of the same bill succeeds.
    await db.print_jobs.bulkAdd([
      {
        id: 'j1',
        sale_id: 's1',
        kind: 'sale',
        status: 'failed',
        created_at: NOW + 10,
      },
      {
        id: 'j2',
        sale_id: 's1',
        kind: 'sale',
        status: 'done',
        created_at: NOW + 11,
      },
    ]);
    expect(
      (await salesHistory(db, day)).rows.find((r) => r.sale.id === 's1')
        ?.printFailed,
    ).toBe(false);
    await db.print_jobs.add({
      id: 'j3',
      sale_id: 's1',
      kind: 'sale',
      status: 'failed',
      created_at: NOW + 12,
    });
    expect(
      (await salesHistory(db, day)).rows.find((r) => r.sale.id === 's1'),
    ).toMatchObject({ printFailed: true, printJobId: 'j3' });
    await db.print_jobs.add({
      id: 'j4',
      sale_id: 's1',
      kind: 'sale',
      status: 'queued',
      created_at: NOW + 13,
    });
    expect(
      (await salesHistory(db, day)).rows.find((r) => r.sale.id === 's1')
        ?.printFailed,
    ).toBe(true);
    await db.print_jobs.add({
      id: 'j5',
      sale_id: 's1',
      kind: 'sale',
      status: 'done',
      created_at: NOW + 14,
    });
    expect(
      (await salesHistory(db, day)).rows.find((r) => r.sale.id === 's1')
        ?.printFailed,
    ).toBe(false);
  });

  it('bill detail covers missing links, quick sales, refunds, voids and conflicts', async () => {
    const { db } = await rawHistory();
    expect(await billDetail(db, 'missing')).toBeNull();

    await db.print_jobs.add({
      id: 'j-detail',
      sale_id: 's1',
      kind: 'sale',
      status: 'done',
      created_at: NOW,
    });
    const s1 = await billDetail(db, 's1');
    expect(s1).toMatchObject({
      customer: null,
      staffName: 'Adnan',
      deviceName: 'Counter 1',
      branchName: 'Main',
      refundedTotal: 0,
      conflicts: [],
    });
    expect(s1?.latestJob?.id).toBe('j-detail');

    const s3 = await billDetail(db, 's3');
    expect(s3?.deviceName).toBe('');
    expect(s3?.lines[0]).toMatchObject({ unit: 'pc', trackStock: false });
    expect(s3?.latestJob).toBeUndefined();

    const s5 = await billDetail(db, 's5');
    expect(s5).toMatchObject({
      staffName: '',
      deviceName: '',
      branchName: '',
      customer: null,
    });

    // Conflicts are matched by the sale_id inside fields_json; bad JSON is ignored.
    await db.sync_conflicts.bulkAdd([
      {
        id: 'c1',
        tbl: 'refund_lines',
        row_id: 'x',
        kind: 'over_refund',
        fields_json: 'not-json',
        resolution: 'needs_owner',
        at: NOW,
      },
      {
        id: 'c2',
        tbl: 'refund_lines',
        row_id: 'y',
        kind: 'over_refund',
        fields_json: JSON.stringify({ sale_id: 's1' }),
        resolution: 'needs_owner',
        at: NOW,
      },
    ]);
    expect((await billDetail(db, 's1'))?.conflicts).toHaveLength(1);

    // A refund whose staff row is missing, a refund with no staff, and an audit row.
    await db.refunds.bulkAdd([
      {
        ...base,
        id: 'r1',
        sale_id: 's1',
        kind: 'partial',
        reason: 'Faulty',
        method: 'cash',
        exact_amount: 1000,
        udhaar_part: 0,
        rounding: 0,
        amount: 1000,
        staff_id: 'missing',
      },
      {
        ...base,
        id: 'r2',
        sale_id: 's2',
        kind: 'whole',
        reason: 'Changed mind',
        method: null,
        exact_amount: 500,
        udhaar_part: 500,
        rounding: 0,
        amount: 0,
        staff_id: '',
        customer_id: null,
      },
    ]);
    await db.refund_lines.bulkAdd([
      {
        id: 'rl1',
        refund_id: 'r1',
        sale_line_id: 'l1',
        qty_milli: 100,
        amount: 1000,
        restock: 1,
        created_at: NOW,
      },
      {
        id: 'rl2',
        refund_id: 'r2',
        sale_line_id: 'l2',
        qty_milli: 100,
        amount: 500,
        restock: 0,
        created_at: NOW,
      },
    ]);
    await db.audit_log.add({
      id: 'a1',
      action: 'refund',
      entity: 'refunds',
      entity_id: 'r1',
      before_json: null,
      after_json: null,
      device_id: 'dev-1',
      staff_id: 'st-1',
      created_at: NOW,
    });
    const withRefunds = await billDetail(db, 's1');
    expect(withRefunds?.refunds[0]?.staffName).toBe('');
    expect(withRefunds?.audit.map((a) => a.action)).toContain('refund');
    expect((await billDetail(db, 's2'))?.refunds[0]?.staffName).toBeNull();
    expect((await billDetail(db, 's2'))?.refundedTotal).toBe(500);

    // Void and replacement links.
    await db.sales.bulkAdd([
      saleRow('old', { status: 'void', total: 10000 }),
      saleRow('new', {
        replaces_sale_id: 'old',
        invoice_no: 'A-A-new',
        created_at: NOW + 1,
      }),
    ]);
    await db.sale_voids.add({
      id: 'v1',
      sale_id: 'old',
      reason: 'Wrong item',
      replacement_sale_id: 'new',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: '2026-10-27',
      created_at: NOW,
    });
    await db.payments.add(
      paymentRow('vp1', 'old', {
        direction: 'out',
        purpose: 'void',
        amount: 10000,
      }),
    );
    await db.audit_log.add({
      id: 'a2',
      action: 'void',
      entity: 'sale_voids',
      entity_id: 'v1',
      before_json: null,
      after_json: null,
      device_id: 'dev-1',
      staff_id: 'st-1',
      created_at: NOW,
    });
    expect(await billDetail(db, 'old')).toMatchObject({
      replacementInvoiceNo: 'A-A-new',
      replacementSaleId: 'new',
      replacedInvoiceNo: null,
    });
    expect((await billDetail(db, 'old'))?.voidPayments).toHaveLength(1);
    expect((await billDetail(db, 'old'))?.audit.map((a) => a.action)).toContain(
      'void',
    );
    expect(await billDetail(db, 'new')).toMatchObject({
      replacedInvoiceNo: 'A-A-old',
      replacedSaleId: 'old',
    });
  });

  it('CSV covers walk-in rows, bank amounts and empty staff/device', async () => {
    const { db } = await rawHistory();
    const day = { from: '2026-10-27', to: '2026-10-27' };
    const history = await salesHistory(db, day);
    const csv = salesCsv(history.rows, 'Asia/Karachi');
    expect(csv).toContain(
      'A-A-s1,2026-10-27,14:00,,1,100,0,0,100,50,50,0,0,0,paid,Adnan,Counter 1',
    );
    expect(csv).toContain('A-A-s6,2026-10-27,14:00,Gone');
    expect(csv).toContain(
      'A-A-s5,2026-10-27,14:00,,1,100,0,0,100,100,0,0,0,0,paid,,',
    );
  });
});
