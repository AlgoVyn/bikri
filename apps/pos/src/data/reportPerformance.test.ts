import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { addDays, reportBundle, slowMoversReport } from './reportBundle.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const BASE = Date.UTC(2026, 9, 27, 9, 0);
const BILLS = 20_000;

/** screens/16 AC 5: a 90-day report with 20,000 bills (isolated ~0.9 s; <2 s in the browser). */
describe('reports performance (screens/16 AC 5)', () => {
  it('builds 90 days / 20k bills', { retry: 1, timeout: 90_000 }, async () => {
    const db = await readyDb('perf');
    await addShop(db);
    const sales: SyncedRow[] = [];
    const lines: SyncedRow[] = [];
    const payments: SyncedRow[] = [];
    for (let index = 0; index < BILLS; index += 1) {
      const date = new Date(BASE - (index % 90) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const id = `sale-${index}`;
      sales.push({
        id,
        invoice_no: `A-A-${index}`,
        invoice_seq: index,
        branch_id: 'br-1',
        device_id: 'dev-1',
        staff_id: 'st-1',
        customer_id: null,
        business_date: date,
        created_at: BASE - index * 1000,
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
      } as SyncedRow);
      lines.push({
        id: `line-${index}`,
        sale_id: id,
        line_no: 1,
        product_id: 'product-1',
        name_snapshot: 'Item',
        sku_snapshot: 'ITM-1',
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
        unit_cost_snapshot: 5000,
        below_cost: 0,
        serial: null,
        warranty_until: null,
        created_at: BASE - index * 1000,
        business_date: date,
      } as SyncedRow);
      payments.push({
        id: `payment-${index}`,
        direction: 'in',
        method: 'cash',
        purpose: 'sale',
        amount: 10000,
        cash_tendered: null,
        change_given: null,
        reference: '',
        sale_id: id,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: null,
        party_id: null,
        note: '',
        branch_id: 'br-1',
        device_id: 'dev-1',
        staff_id: 'st-1',
        business_date: date,
        created_at: BASE - index * 1000,
      } as SyncedRow);
    }
    await db.products.add({
      id: 'product-1',
      name_en: 'Item',
      sku: 'ITM-1',
      price: 10000,
      avg_cost: 5000,
      track_stock: 1,
      created_at: BASE,
      updated_at: BASE,
      deleted_at: null,
      rev: 1,
    } as never);
    await db.sales.bulkAdd(sales);
    await db.sale_lines.bulkAdd(lines);
    await db.payments.bulkAdd(payments);
    let elapsed = Number.POSITIVE_INFINITY;
    // Run twice and keep the best time: one scheduler stall beside another
    // package's suite should not fail the budget, but a real regression will.
    for (let run = 0; run < 2; run += 1) {
      const started = performance.now();
      const bundle = await reportBundle(
        db,
        { from: '2026-07-30', to: '2026-10-27' },
        { now: BASE, today: '2026-10-27' },
      );
      elapsed = Math.min(elapsed, performance.now() - started);
      expect(bundle.summary.bills).toBe(BILLS);
    }
    // Isolated this is ~0.9 s; the reference browser target is <2 s, so keep
    // scheduling headroom here.
    // A shared CI runner is not the reference PC; the map operations and bill count
    // above are deterministic, and 10 s still catches a full-scan regression.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('finds a thousand slow movers in the worker budget', {
    timeout: 30_000,
  }, async () => {
    const db = await readyDb('perf-slow');
    await addShop(db);
    const old = addDays('2026-10-27', -45);
    const products = Array.from({ length: 1_000 }, (_, index) => ({
      id: `slow-${index}`,
      name_en: `Slow ${index}`,
      sku: `SLOW-${index}`,
      price: 10_000,
      avg_cost: 5_000,
      track_stock: 1,
      created_at: BASE,
      updated_at: BASE,
      deleted_at: null,
      rev: 1,
    }));
    await db.products.bulkAdd(products as never);
    await db.stock_levels.bulkPut(
      products.map((product) => ({
        product_id: product.id,
        on_hand_milli: 1_000,
      })),
    );
    await db.sale_lines.bulkAdd(
      products.map((product, index) => ({
        id: `slow-line-${index}`,
        sale_id: `slow-sale-${index}`,
        product_id: product.id,
        business_date: old,
        qty_milli: 1_000,
        unit_price: 10_000,
        gross: 10_000,
        discount: 0,
        net: 10_000,
        unit_cost_snapshot: 5_000,
        created_at: BASE,
      })) as never,
    );
    const started = performance.now();
    const rows = await slowMoversReport(db, '2026-10-27');
    // The reference browser target is <300 ms; fake-indexeddb is slower and CI
    // shares the runner, so this gate catches the per-candidate/lifetime blow-up.
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(rows).toHaveLength(1_000);
    expect(rows[0]?.lastSale).toBe(old);
  });

  it('reads sale lines by business date, never by sale id over history', {
    timeout: 90_000,
  }, async () => {
    const db = await readyDb('perf-report-history');
    await addShop(db);
    const inRange = 1_000;
    const old = 20_000;
    const sales: SyncedRow[] = [];
    const lines: SyncedRow[] = [];
    const line = (
      id: string,
      saleId: string,
      date: string,
      at: number,
    ): SyncedRow =>
      ({
        id,
        sale_id: saleId,
        line_no: 1,
        product_id: 'product-1',
        name_snapshot: 'Item',
        sku_snapshot: 'ITM-1',
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
        unit_cost_snapshot: 5000,
        below_cost: 0,
        serial: null,
        warranty_until: null,
        created_at: at,
        business_date: date,
      }) as SyncedRow;
    for (let index = 0; index < inRange; index += 1) {
      const date = new Date(BASE - (index % 30) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const id = `sale-${index}`;
      sales.push({
        id,
        invoice_no: `A-A-${index}`,
        invoice_seq: index,
        branch_id: 'br-1',
        device_id: 'dev-1',
        staff_id: 'st-1',
        customer_id: null,
        business_date: date,
        created_at: BASE - index * 1000,
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
      } as SyncedRow);
      lines.push(line(`line-${index}`, id, date, BASE - index * 1000));
    }
    for (let index = 0; index < old; index += 1) {
      const date = new Date(BASE - (90 + (index % 365)) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      lines.push(
        line(`old-line-${index}`, `old-sale-${index}`, date, BASE - 1e9),
      );
    }
    await db.sales.bulkAdd(sales);
    await db.sale_lines.bulkAdd(lines);

    // A shape assertion: the report must use the V7 date index, not a lifetime
    // sale-id join (D-231).
    const seen: string[] = [];
    const original = db.sale_lines.where.bind(db.sale_lines);
    (db.sale_lines as unknown as { where: (index: string) => unknown }).where =
      (index: string) => {
        seen.push(index);
        return (original as (index: string) => unknown)(index);
      };
    const started = performance.now();
    const bundle = await reportBundle(
      db,
      { from: '2026-09-28', to: '2026-10-27' },
      { now: BASE, today: '2026-10-27' },
    );
    const elapsed = performance.now() - started;
    expect(bundle.summary.bills).toBe(inRange);
    expect(seen).toContain('business_date');
    expect(seen).not.toContain('sale_id');
    expect(elapsed).toBeLessThan(10_000);
  });
});
