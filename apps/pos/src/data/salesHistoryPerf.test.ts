import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { salesHistory } from './salesHistory.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const BASE = Date.UTC(2026, 9, 27, 9, 0);
const BILLS = 5_000;
const DAYS = 30;
const END = '2026-10-27';
const START = '2026-09-28';

/**
 * The 15 Nov review measured the Sales list at 52 s for 10,000 bills because every bill
 * opened one index range for its payments, refunds and print jobs. This keeps 5,000
 * bills (20,000 rows including lines and payments) inside a 30-day range so a regression
 * to per-bill probes fails CI rather than a shop's till.
 */
describe('sales list performance (screens/10, D-225)', () => {
  it('lists 5,000 bills in a 30-day range within the data-layer budget', {
    retry: 1,
    timeout: 120_000,
  }, async () => {
    const db = await readyDb('sales-perf');
    await addShop(db);
    const sales: SyncedRow[] = [];
    const lines: SyncedRow[] = [];
    const payments: SyncedRow[] = [];
    for (let index = 0; index < BILLS; index += 1) {
      const date = new Date(BASE - (index % DAYS) * 86_400_000)
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
      } as SyncedRow);
      payments.push({
        id: `payment-${index}`,
        direction: 'in',
        method: index % 3 === 0 ? 'card' : 'cash',
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
    await db.sales.bulkAdd(sales);
    await db.sale_lines.bulkAdd(lines);
    await db.payments.bulkAdd(payments);

    let elapsed = Number.POSITIVE_INFINITY;
    // Best of two runs: a scheduler stall beside another suite must not fail the gate,
    // but the per-bill query shape would still take tens of seconds.
    for (let run = 0; run < 2; run += 1) {
      const started = performance.now();
      const history = await salesHistory(db, { from: START, to: END });
      elapsed = Math.min(elapsed, performance.now() - started);
      expect(history.rows).toHaveLength(BILLS);
      expect(history.summary.bills).toBe(BILLS);
      expect(history.rows[0]?.methods.length).toBeGreaterThan(0);
    }
    // Isolated this is ~1 s in fake-indexeddb; the browser is faster. A per-bill
    // anyOf regression is >30 s, so 6 s leaves CI headroom without hiding it.
    expect(elapsed).toBeLessThan(6_000);
  });
});
