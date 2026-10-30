import { businessDate } from '@bikri/core';
import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { seedSampleDay } from '../dev/sampleDay.ts';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import { reportBundle, reportDays } from './reportBundle.ts';
import { reportCsv, reportTotal } from './reportCsv.ts';
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

const TZ = 'Asia/Karachi';
const TODAY = businessDate(NOW, TZ);
const YESTERDAY = businessDate(NOW - 86_400_000, TZ);
const row = { created_at: NOW, updated_at: NOW, deleted_at: null, rev: 1 };

async function sample(prefix = 'report') {
  const db = await readyDb(prefix);
  await addShop(db, { timezone: TZ });
  await seedSampleDay(db, TODAY, NOW);
  return db;
}

describe('report bundle (screens/16 ACs 1–3, 6)', () => {
  it('validates report ranges and fills defaults', async () => {
    expect(reportDays('nope', TODAY)).toEqual([]);
    expect(() => reportDays('2025-01-01', '2026-06-01')).toThrow(RangeError);
    expect(reportDays(TODAY, TODAY)).toEqual([TODAY]);
    expect(reportDays('2026-10-28', '2026-10-27')).toEqual([]);
    const db = await sample('defaults');
    const bundle = await reportBundle(db, { from: TODAY, to: TODAY });
    expect(bundle.summary.bills).toBe(2);
  });

  it('AC 1: Today sold, profit, expenses, mix and udhaar match the sample day', async () => {
    const db = await sample();
    const bundle = await reportBundle(
      db,
      { from: TODAY, to: TODAY },
      { now: NOW + 10, today: TODAY },
    );
    expect(bundle.summary).toMatchObject({
      sold: 100000,
      bills: 2,
      avgBill: 50000,
      grossProfit: 40000,
      expenses: 5000,
      netProfit: 35000,
      udhaarGiven: 30000,
      udhaarReceived: 10000,
      tax: 0,
      refundCount: 1,
      refunded: 50000,
      paymentMix: { cash: 70000, card: 0, bank_wallet: 0, udhaar: 30000 },
    });
    expect(bundle.summary.daily).toHaveLength(1);
    expect(bundle.summary.daily[0]).toMatchObject({
      date: TODAY,
      sold: 100000,
      bills: 2,
      grossProfit: 40000,
      expenses: 5000,
      netProfit: 35000,
    });
    expect(bundle.products.rows[0]).toMatchObject({
      name: 'Charger',
      qtyMilli: 2000,
      revenue: 100000,
      cost: 60000,
      profit: 40000,
    });
    expect(bundle.products.bestByQty[0]?.name).toBe('Charger');
    expect(bundle.expenses.rows).toMatchObject([
      { amount: 5000, shareBp: 10000 },
    ]);
    expect(bundle.staff).toMatchObject([
      {
        name: 'Adnan',
        bills: 2,
        sold: 150000,
        refunds: 1,
        refunded: 50000,
        netSold: 100000,
      },
    ]);
    expect(bundle.udhaar.totalOwed).toBe(20000);
    expect(bundle.udhaar.count).toBe(1);

    const filtered = await reportBundle(
      db,
      { from: TODAY, to: TODAY, deviceId: 'other' },
      { now: NOW + 10, today: TODAY },
    );
    expect(filtered.summary.sold).toBe(0);
    expect(filtered.staff).toEqual([]);
  });

  it('AC 2: T2 profit is exactly Rs 2,500.00', async () => {
    const { db, ctx, phone, buds } = await shopWithStock('t2');
    await addShop(db, { timezone: TZ, tax_rate_bp: 0 });
    const buds250 = { ...buds, avg_cost: 250000, last_cost: 250000 };
    await db.products.put(buds250);
    const cart = t2Cart(phone, buds250);
    await db.carts.put(cart);
    await completeSale(
      db,
      sale(cart, [{ method: 'cash', amount: 4300000 }], { saleId: 't2-sale' }),
      ctx,
      NOW,
    );
    const bundle = await reportBundle(
      db,
      { from: TODAY, to: TODAY },
      { now: NOW + 10, today: TODAY },
    );
    expect(bundle.summary).toMatchObject({
      sold: 4300000,
      bills: 1,
      grossProfit: 250000,
      marginBp: 581,
      paymentMix: { cash: 4300000, card: 0, bank_wallet: 0, udhaar: 0 },
    });
    expect(bundle.products.rows.map((line) => line.name).sort()).toEqual([
      'Earbuds',
      'Galaxy A15',
    ]);
    expect(
      bundle.products.rows.reduce((sum, line) => sum + line.profit, 0),
    ).toBe(250000);
  });

  it('AC 3: a refund today reduces today, never yesterday', async () => {
    const db = await readyDb('refund-day');
    await addShop(db, { timezone: TZ });
    await db.sales.add({
      ...row,
      id: 'sale-yesterday',
      invoice_no: 'A-A-1',
      invoice_seq: 1,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: YESTERDAY,
      line_count: 1,
      items_qty_milli: 1000,
      gross_total: 100000,
      item_discount_total: 0,
      subtotal: 100000,
      bill_discount_type: null,
      bill_discount_value: 0,
      bill_discount: 0,
      tax_rate_bp: 0,
      tax: 0,
      tax_inclusive: 0,
      rounding: 0,
      total: 100000,
      paid_total: 100000,
      udhaar_amount: 0,
      cash_tendered: 100000,
      change_given: 0,
      status: 'paid',
      replaces_sale_id: null,
      note: '',
    } as SyncedRow);
    await db.sale_lines.add({
      id: 'line-yesterday',
      sale_id: 'sale-yesterday',
      line_no: 1,
      product_id: null,
      name_snapshot: 'Charger',
      sku_snapshot: '',
      qty_milli: 1000,
      unit_price: 100000,
      gross: 100000,
      discount_type: null,
      discount_value: 0,
      discount: 0,
      net: 100000,
      bill_discount_alloc: 0,
      tax_alloc: 0,
      rounding_alloc: 0,
      unit_cost_snapshot: 50000,
      below_cost: 0,
      serial: null,
      warranty_until: null,
      created_at: NOW - 86_400_000,
    } as SyncedRow);
    await db.refunds.add({
      id: 'refund-today',
      sale_id: 'sale-yesterday',
      kind: 'whole',
      reason: 'Faulty',
      method: 'cash',
      exact_amount: 100000,
      udhaar_part: 0,
      rounding: 0,
      amount: 100000,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW + 1,
    } as SyncedRow);
    await db.refund_lines.add({
      id: 'refund-line',
      refund_id: 'refund-today',
      sale_line_id: 'line-yesterday',
      qty_milli: 1000,
      amount: 100000,
      restock: 1,
      created_at: NOW + 1,
    } as SyncedRow);

    const yesterday = await reportBundle(
      db,
      { from: YESTERDAY, to: YESTERDAY },
      { now: NOW + 10, today: TODAY },
    );
    expect(yesterday.summary).toMatchObject({
      sold: 100000,
      bills: 1,
      grossProfit: 50000,
    });
    const today = await reportBundle(
      db,
      { from: TODAY, to: TODAY },
      { now: NOW + 10, today: TODAY },
    );
    expect(today.summary).toMatchObject({
      sold: -100000,
      bills: 0,
      grossProfit: -50000,
      refunded: 100000,
      paymentMix: { cash: -100000, udhaar: 0 },
    });
    expect(today.products.rows[0]).toMatchObject({
      name: 'Charger',
      qtyMilli: -1000,
      revenue: -100000,
      profit: -50000,
    });
    expect(reportCsv('products', today)).toContain('0.00');
  });

  it('covers every tab CSV, mixed payment methods, aging buckets and voids', async () => {
    const db = await sample('coverage');
    await db.categories.add({
      id: 'cat-1',
      name_en: 'Accessories',
      name_ur: 'لوازمات',
      color: 't1',
      sort_order: 1,
      ...row,
    } as never);
    await db.products.add({
      ...row,
      id: 'case-1',
      name_en: 'Case',
      name_ur: 'کیس',
      sku: 'CASE-1',
      brand: 'BrandX',
      category_id: 'cat-1',
      unit: 'pc',
      price: 30000,
      last_cost: 10000,
      avg_cost: 10000,
      min_stock_milli: 0,
      track_stock: 1,
      tax_rate_bp: null,
      track_serial: 0,
      warranty_days: 0,
      pack_size_milli: null,
      image_key: null,
      notes: '',
    } as never);
    await db.products.add({
      ...row,
      id: 'slow-1',
      name_en: 'Slow cable',
      name_ur: '',
      sku: 'SLOW-1',
      brand: '',
      category_id: null,
      unit: 'pc',
      price: 10000,
      last_cost: 5000,
      avg_cost: 5000,
      min_stock_milli: 0,
      track_stock: 1,
      tax_rate_bp: null,
      track_serial: 0,
      warranty_days: 0,
      pack_size_milli: null,
      image_key: null,
      notes: '',
    } as never);
    await db.stock_levels.put({ product_id: 'slow-1', on_hand_milli: 5000 });
    await db.products.add({
      ...row,
      id: 'nulls-1',
      name_en: 'Nulls',
      name_ur: '',
      sku: 'NULL-1',
      brand: '',
      category_id: null,
      unit: 'pc',
      price: 1000,
      last_cost: null,
      avg_cost: null,
      min_stock_milli: null,
      track_stock: 1,
      tax_rate_bp: null,
      track_serial: 0,
      warranty_days: 0,
      pack_size_milli: null,
      image_key: null,
      notes: '',
    } as never);
    await db.stock_levels.put({ product_id: 'nulls-1', on_hand_milli: 0 });
    await db.sales.add({
      ...row,
      id: 'sale-cov',
      invoice_no: 'A-A-9',
      invoice_seq: 9,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      customer_id: null,
      business_date: TODAY,
      line_count: 1,
      items_qty_milli: 1000,
      gross_total: 30000,
      item_discount_total: 0,
      subtotal: 30000,
      bill_discount_type: null,
      bill_discount_value: 0,
      bill_discount: 0,
      tax_rate_bp: 0,
      tax: 0,
      tax_inclusive: 0,
      rounding: 0,
      total: 30000,
      paid_total: 30000,
      udhaar_amount: 0,
      cash_tendered: 0,
      change_given: 0,
      status: 'paid',
      replaces_sale_id: null,
      note: '',
    } as SyncedRow);
    await db.sale_lines.add({
      id: 'line-cov',
      sale_id: 'sale-cov',
      line_no: 1,
      product_id: 'case-1',
      name_snapshot: 'Case',
      sku_snapshot: 'CASE-1',
      qty_milli: 1000,
      unit_price: 30000,
      gross: 30000,
      discount_type: null,
      discount_value: 0,
      discount: 0,
      net: 30000,
      bill_discount_alloc: 0,
      tax_alloc: 0,
      rounding_alloc: 0,
      unit_cost_snapshot: 10000,
      below_cost: 0,
      serial: null,
      warranty_until: null,
      created_at: NOW + 2,
    } as SyncedRow);
    await db.payments.bulkAdd([
      {
        id: 'pay-card',
        direction: 'in',
        method: 'card',
        purpose: 'sale',
        amount: 20000,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: 'sale-cov',
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
        created_at: NOW + 2,
      },
      {
        id: 'pay-bank',
        direction: 'in',
        method: 'bank_wallet',
        purpose: 'sale',
        amount: 10000,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: 'sale-cov',
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
        created_at: NOW + 2,
      },
      {
        id: 'pay-void',
        direction: 'out',
        method: 'cash',
        purpose: 'void',
        amount: 5000,
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
        created_at: NOW + 3,
      },
    ] as SyncedRow[]);
    await db.sale_voids.add({
      id: 'void-cov',
      sale_id: 'missing-sale',
      reason: 'Wrong item',
      replacement_sale_id: null,
      device_id: 'dev-1',
      staff_id: 'st-2',
      business_date: TODAY,
      created_at: NOW + 3,
    } as SyncedRow);
    await db.stock_movements.add({
      id: 'mv-cov-sale',
      product_id: 'case-1',
      qty_delta_milli: -1000,
      reason_code: 'sale',
      ref_type: 'sale',
      ref_id: 'sale-cov',
      unit_cost: null,
      note: '',
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW + 2,
    } as SyncedRow);
    await db.customers.bulkAdd([
      {
        ...row,
        id: 'cust-8',
        name: 'Eight Days',
        phone: '',
        address: '',
        note: '',
        credit_limit: null,
        hard_limit: 0,
      },
      {
        ...row,
        id: 'cust-31',
        name: 'Thirty One',
        phone: '0300',
        address: '',
        note: '',
        credit_limit: null,
        hard_limit: 0,
      },
      {
        ...row,
        id: 'cust-60',
        name: 'Sixty Plus',
        phone: '0301',
        address: '',
        note: '',
        credit_limit: null,
        hard_limit: 0,
      },
      {
        ...row,
        id: 'cust-neg',
        name: 'In Credit',
        phone: '',
        address: '',
        note: '',
        credit_limit: null,
        hard_limit: 0,
      },
    ] as never[]);
    await db.party_balances.bulkAdd([
      {
        party_type: 'customer',
        party_id: 'cust-8',
        balance: 800,
        last_activity_at: NOW,
        oldest_unpaid_at: NOW - 10 * 86_400_000,
      },
      {
        party_type: 'customer',
        party_id: 'cust-31',
        balance: 3100,
        last_activity_at: NOW,
        oldest_unpaid_at: NOW - 40 * 86_400_000,
      },
      {
        party_type: 'customer',
        party_id: 'cust-60',
        balance: 6000,
        last_activity_at: NOW,
        oldest_unpaid_at: NOW - 70 * 86_400_000,
      },
      {
        party_type: 'customer',
        party_id: 'cust-neg',
        balance: -100,
        last_activity_at: NOW,
        oldest_unpaid_at: null,
      },
      {
        party_type: 'customer',
        party_id: 'missing-customer',
        balance: 100,
        last_activity_at: NOW,
        oldest_unpaid_at: NOW,
      },
    ]);
    await db.expenses.add({
      id: 'expense-missing-category',
      category_id: 'missing-category',
      amount: 1000,
      method: 'cash',
      payee: '',
      note: '',
      reverses_id: null,
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW + 4,
    } as SyncedRow);
    await db.day_closes.add({
      id: 'dc-cov',
      device_id: 'dev-1',
      branch_id: 'br-1',
      staff_id: 'st-1',
      business_date: TODAY,
      period_start: 0,
      period_end: NOW,
      opening_cash: 0,
      cash_sales: 0,
      udhaar_cash_in: 0,
      pay_ins: 0,
      supplier_cash_in: 0,
      cash_refunds: 0,
      cash_expenses: 0,
      supplier_cash_out: 0,
      pay_outs: 0,
      expected_cash: 100000,
      counted_cash: 99000,
      difference: -1000,
      denominations_json: null,
      note: 'Short, counted twice',
      created_at: NOW + 5,
    } as SyncedRow);
    await db.day_closes.add({
      id: 'dc-null-note',
      device_id: 'missing-device',
      branch_id: 'br-1',
      staff_id: 'missing-staff',
      business_date: TODAY,
      period_start: 0,
      period_end: NOW,
      opening_cash: 0,
      cash_sales: 0,
      udhaar_cash_in: 0,
      pay_ins: 0,
      supplier_cash_in: 0,
      cash_refunds: 0,
      cash_expenses: 0,
      supplier_cash_out: 0,
      pay_outs: 0,
      expected_cash: 100,
      counted_cash: 100,
      difference: 0,
      denominations_json: null,
      note: null,
      created_at: NOW - 1,
    } as SyncedRow);

    const bundle = await reportBundle(
      db,
      { from: TODAY, to: TODAY },
      { now: NOW + 10, today: TODAY },
    );
    expect(bundle.summary.paymentMix).toMatchObject({
      cash: 65000,
      card: 20000,
      bank_wallet: 10000,
      udhaar: 30000,
    });
    expect(bundle.products.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'cat-1', name: 'Accessories' }),
        expect.objectContaining({ key: 'none' }),
      ]),
    );
    expect(bundle.products.brands.map((brand) => brand.key).sort()).toEqual([
      '',
      'BrandX',
    ]);
    expect(bundle.products.slowMovers.map((row) => row.product.id)).toEqual([
      'slow-1',
    ]);
    expect(
      bundle.udhaar.buckets.map((bucket) => [bucket.key, bucket.count]),
    ).toEqual([
      ['promise', 0],
      ['0-7', 1],
      ['8-30', 1],
      ['31-60', 1],
      ['60+', 1],
    ]);
    expect(bundle.staff.find((row) => row.staffId === 'st-2')).toMatchObject({
      name: '',
      voids: 1,
      voided: 0,
    });
    expect(bundle.dayCloses.rows[0]?.close.note).toBe('Short, counted twice');
    expect(bundle.expenses.rows.some((row) => row.category === null)).toBe(
      true,
    );

    expect(
      reportCsv('stock', bundle, { includeCost: false }).split('\r\n')[0],
    ).toBe('product,sku,on_hand,min_stock,status');
    const stockCsv = reportCsv('stock', bundle);
    expect(stockCsv).toContain('Slow cable');
    expect(stockCsv).toContain('250.00');
    expect(reportCsv('products', bundle, { includeCost: false })).toContain(
      'Case',
    );
    expect(reportCsv('products', bundle)).toContain('66.67');
    const summaryHeader = reportCsv('summary', bundle, {
      includeCost: false,
    }).split('\r\n')[0];
    expect(summaryHeader).not.toContain('gross_profit');
    expect(summaryHeader).not.toContain('net_profit');
    expect(reportCsv('summary', bundle).split('\r\n')[0]).toContain(
      'gross_profit',
    );
    expect(reportCsv('udhaar', bundle)).toContain('Sixty Plus');
    expect(reportCsv('staff', bundle)).toContain('Adnan');
    const closesCsv = reportCsv('day_closes', bundle);
    expect(closesCsv).toContain('"Short, counted twice"');
    expect(reportCsv('expenses', bundle)).toContain('Uncategorized');
    expect(reportTotal('summary', bundle)).toBe(bundle.summary.sold);
    expect(reportTotal('products', bundle)).toBeGreaterThan(0);
    expect(reportTotal('stock', bundle)).toBe(bundle.stock.value);
    expect(reportTotal('udhaar', bundle)).toBe(bundle.udhaar.totalOwed);
    expect(reportTotal('staff', bundle)).toBeGreaterThan(0);
    expect(reportTotal('day_closes', bundle)).toBe(-1000);
    expect(reportTotal('expenses', bundle)).toBe(bundle.expenses.total);
  });

  it('AC 6: every tab has its documented CSV header and rupees with two decimals', async () => {
    const db = await sample('csv');
    const bundle = await reportBundle(
      db,
      { from: TODAY, to: TODAY },
      { now: NOW + 10, today: TODAY },
    );
    expect(reportCsv('summary', bundle).split('\r\n')[0]).toBe(
      'date,bills,sold,gross_profit,expenses,net_profit,udhaar_given,udhaar_received,tax_collected,cash,card,bank_wallet,udhaar',
    );
    expect(reportCsv('products', bundle).split('\r\n')[0]).toBe(
      'product,sku,qty_sold,revenue,cost,profit,margin_pct',
    );
    expect(
      reportCsv('products', bundle, { includeCost: false }).split('\r\n')[0],
    ).toBe('product,sku,qty_sold,revenue');
    expect(reportCsv('stock', bundle).split('\r\n')[0]).toBe(
      'product,sku,on_hand,min_stock,avg_cost,stock_value,status',
    );
    expect(reportCsv('udhaar', bundle).split('\r\n')[0]).toBe(
      'bucket,name,phone,balance,age_days,promise_date',
    );
    expect(reportCsv('staff', bundle).split('\r\n')[0]).toBe(
      'cashier,bills,sold,discounts,refunds,refunded_amount,voids,voided_amount,net_sold',
    );
    expect(reportCsv('day_closes', bundle).split('\r\n')[0]).toBe(
      'date,device,cashier,expected,counted,difference,note',
    );
    expect(reportCsv('expenses', bundle).split('\r\n')[0]).toBe(
      'category,amount,share_pct',
    );
    const summary = reportCsv('summary', bundle).split('\r\n');
    const todayRow = summary.find((line) => line.startsWith(`${TODAY},`));
    expect(todayRow?.split(',')[2]).toBe('1000.00');
    expect(summary.at(-1)?.split(',')[0]).toBe('TOTAL');
    expect(summary.at(-1)?.split(',')[2]).toBe('1000.00');
    const product = reportCsv('products', bundle).split('\r\n')[1];
    expect(product?.split(',')[3]).toBe('1000.00');
    const expense = reportCsv('expenses', bundle).split('\r\n')[1];
    expect(expense?.split(',')[1]).toBe('50.00');
  });
});

describe('report tabs (screens/16)', () => {
  it('stock value, attention, movements and supplier return differences', async () => {
    const db = await readyDb('stock-tab');
    await addShop(db, { timezone: TZ });
    const ctx = await ledgerContext(db, 'st-1');
    const tracked = await saveNewProduct(
      db,
      {
        name_en: 'Cable',
        sku: 'CBL-1',
        price: 50000,
        cost: 30000,
        opening_milli: 5000,
        min_stock_milli: 6000,
        track_stock: true,
      },
      ctx,
      { now: NOW },
    );
    const out = await saveNewProduct(
      db,
      {
        name_en: 'Empty',
        sku: 'EMP-1',
        price: 10000,
        cost: 5000,
        opening_milli: 0,
        track_stock: true,
      },
      ctx,
      { now: NOW + 1 },
    );
    await db.products.add({
      ...row,
      id: 'negative-product',
      name_en: 'Negative',
      name_ur: '',
      sku: 'NEG-1',
      brand: '',
      category_id: null,
      unit: 'pc',
      price: 10000,
      last_cost: 5000,
      avg_cost: 5000,
      min_stock_milli: 0,
      track_stock: 1,
      tax_rate_bp: null,
      track_serial: 0,
      warranty_days: 0,
      pack_size_milli: null,
      image_key: null,
      notes: '',
    } as never);
    await db.stock_levels.put({
      product_id: 'negative-product',
      on_hand_milli: -500,
    });
    await db.stock_movements.bulkAdd([
      {
        id: 'mv-sale',
        product_id: tracked.id,
        qty_delta_milli: -1000,
        reason_code: 'sale',
        ref_type: 'sale',
        ref_id: null,
        unit_cost: null,
        note: '',
        branch_id: 'br-1',
        device_id: 'dev-1',
        staff_id: 'st-1',
        business_date: TODAY,
        created_at: NOW - 100,
      },
      {
        id: 'mv-damaged',
        product_id: tracked.id,
        qty_delta_milli: -500,
        reason_code: 'damaged',
        ref_type: 'adjustment',
        ref_id: null,
        unit_cost: null,
        note: '',
        branch_id: 'br-1',
        device_id: 'dev-1',
        staff_id: 'st-1',
        business_date: TODAY,
        created_at: NOW - 50,
      },
    ] as SyncedRow[]);
    await db.suppliers.add({
      ...row,
      id: 'sup-1',
      name: 'Ali Traders',
      phone: '',
      address: '',
      note: '',
    } as never);
    await db.supplier_returns.add({
      id: 'ret-1',
      supplier_id: 'sup-1',
      purchase_id: null,
      reason: 'Faulty',
      total: 105000,
      refund_received: 0,
      refund_method: null,
      line_count: 1,
      note: '',
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW - 20,
    } as SyncedRow);
    await db.supplier_return_lines.add({
      id: 'ret-line-1',
      return_id: 'ret-1',
      line_no: 1,
      product_id: tracked.id,
      purchase_line_id: null,
      qty_milli: 3000,
      unit_credit: 35000,
      line_total: 105000,
      cost_snapshot: 30000,
      created_at: NOW - 20,
    } as SyncedRow);

    await db.supplier_returns.add({
      id: 'ret-2',
      supplier_id: 'missing-supplier',
      purchase_id: null,
      reason: 'Unsold',
      total: 50000,
      refund_received: 0,
      refund_method: null,
      line_count: 0,
      note: '',
      branch_id: 'br-1',
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW - 10,
    } as SyncedRow);
    const bundle = await reportBundle(
      db,
      { from: TODAY, to: TODAY },
      { now: NOW + 10, today: TODAY },
    );
    expect(bundle.stock.value).toBe(150000);
    expect(bundle.stock.lowStock.map((item) => item.product.id)).toEqual([
      tracked.id,
    ]);
    expect(bundle.stock.outOfStock.map((item) => item.product.id)).toEqual([
      out.id,
    ]);
    expect(bundle.stock.negativeStock.map((item) => item.product.id)).toEqual([
      'negative-product',
    ]);
    expect(bundle.stock.attention).toHaveLength(3);
    expect(bundle.stock.movements).toMatchObject([
      { reason: 'opening', count: 1, inQty: 5000, netQty: 5000 },
      { reason: 'sale', count: 1, outQty: 1000, netQty: -1000 },
      { reason: 'damaged', count: 1, outQty: 500, netQty: -500 },
    ]);
    expect(bundle.stock.supplierReturns).toMatchObject({
      count: 2,
      credit: 155000,
      difference: 65000,
    });
    expect(
      bundle.stock.items.find((item) => item.product.id === out.id),
    ).toMatchObject({
      status: 'out',
      onHand: 0,
    });
  });

  it('udhaar aging, staff voids and day-close totals', async () => {
    const db = await sample('aging');
    await db.promises.add({
      id: 'promise-1',
      customer_id: (await db.customers.toCollection().first())?.id as string,
      promised_on: YESTERDAY,
      amount: 10000,
      status: 'open',
      ...row,
    } as never);
    await db.promises.add({
      id: 'promise-2',
      customer_id: (await db.customers.toCollection().first())?.id as string,
      promised_on: TODAY,
      amount: 5000,
      status: 'open',
      ...row,
      created_at: NOW + 1,
    } as never);
    const customer = await db.customers.toCollection().first();
    await db.sale_voids.add({
      id: 'void-1',
      sale_id: 'missing-sale',
      reason: 'Wrong item',
      replacement_sale_id: null,
      device_id: 'dev-1',
      staff_id: 'st-1',
      business_date: TODAY,
      created_at: NOW + 1,
    } as SyncedRow);
    await db.day_closes.bulkAdd([
      {
        id: 'dc-1',
        device_id: 'dev-1',
        branch_id: 'br-1',
        staff_id: 'st-1',
        business_date: YESTERDAY,
        period_start: 0,
        period_end: NOW - 86_400_000,
        opening_cash: 0,
        cash_sales: 0,
        udhaar_cash_in: 0,
        pay_ins: 0,
        supplier_cash_in: 0,
        cash_refunds: 0,
        cash_expenses: 0,
        supplier_cash_out: 0,
        pay_outs: 0,
        expected_cash: 100000,
        counted_cash: 99000,
        difference: -1000,
        denominations_json: null,
        note: 'Short',
        created_at: NOW - 86_400_000,
      },
      {
        id: 'dc-2',
        device_id: 'dev-1',
        branch_id: 'br-1',
        staff_id: 'st-1',
        business_date: TODAY,
        period_start: NOW - 86_400_000,
        period_end: NOW,
        opening_cash: 0,
        cash_sales: 0,
        udhaar_cash_in: 0,
        pay_ins: 0,
        supplier_cash_in: 0,
        cash_refunds: 0,
        cash_expenses: 0,
        supplier_cash_out: 0,
        pay_outs: 0,
        expected_cash: 50000,
        counted_cash: 51000,
        difference: 1000,
        denominations_json: null,
        note: '',
        created_at: NOW,
      },
    ] as SyncedRow[]);

    const bundle = await reportBundle(
      db,
      { from: YESTERDAY, to: TODAY },
      { now: NOW + 10, today: TODAY },
    );
    expect(bundle.udhaar.totalOwed).toBe(20000);
    expect(
      bundle.udhaar.buckets.find((bucket) => bucket.key === 'promise'),
    ).toMatchObject({
      total: 20000,
      count: 1,
    });
    expect(bundle.udhaar.top[0]?.customer.id).toBe(customer?.id);
    expect(bundle.staff[0]).toMatchObject({ voids: 1, voided: 0 });
    expect(bundle.dayCloses).toMatchObject({
      expected: 150000,
      counted: 150000,
      difference: 0,
      shortCount: 1,
      shortTotal: 1000,
      overCount: 1,
      overTotal: 1000,
    });
    expect(bundle.dayCloses.rows).toHaveLength(2);
  });
});
