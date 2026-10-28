import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { IDS, seedShop } from './helpers/fixtures.ts';
import { op, pushOk } from './helpers/ops.ts';

// T-062: two large tenants, the documented write budget and the hot-query plans.

const HOT_QUERIES: Array<{
  name: string;
  sql: string;
  args: unknown[];
  index: string;
}> = [
  {
    name: 'change_log pull',
    sql: 'SELECT seq FROM change_log WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT 500',
    args: ['t', 0],
    index: 'change_log_tenant_seq',
  },
  {
    name: 'snapshot page',
    sql: 'SELECT id FROM sales WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT 500',
    args: ['t', '0'],
    index: 'sqlite_autoindex_sales_2',
  },
  {
    name: 'staff lookup',
    sql: 'SELECT id FROM staff WHERE tenant_id = ?',
    args: ['t'],
    index: 'sqlite_autoindex_staff_1',
  },
  {
    name: 'branch lookup',
    sql: 'SELECT id FROM branches WHERE tenant_id = ?',
    args: ['t'],
    index: 'sqlite_autoindex_branches_1',
  },
  {
    name: 'product by id',
    sql: 'SELECT id FROM products WHERE tenant_id = ? AND id = ?',
    args: ['t', 'p'],
    index: 'sqlite_autoindex_products_1',
  },
  {
    name: 'sale by id',
    sql: 'SELECT id FROM sales WHERE tenant_id = ? AND id = ?',
    args: ['t', 's'],
    index: 'sqlite_autoindex_sales_2',
  },
  {
    name: 'refunds by sale',
    sql: 'SELECT id FROM refunds WHERE tenant_id = ? AND sale_id = ?',
    args: ['t', 's'],
    index: 'refunds_sale',
  },
  {
    name: 'payments by refund',
    sql: 'SELECT id FROM payments WHERE tenant_id = ? AND refund_id = ?',
    args: ['t', 'r'],
    index: 'payments_refund',
  },
  {
    name: 'payments by supplier return',
    sql: 'SELECT id FROM payments WHERE tenant_id = ? AND supplier_return_id = ?',
    args: ['t', 'r'],
    index: 'payments_supplier_return',
  },
  {
    name: 'expenses by reversal',
    sql: 'SELECT id FROM expenses WHERE tenant_id = ? AND reverses_id = ?',
    args: ['t', 'e'],
    index: 'expenses_reversal',
  },
  {
    name: 'return lines by return',
    sql: 'SELECT id FROM supplier_return_lines WHERE tenant_id = ? AND return_id = ?',
    args: ['t', 'r'],
    index: 'sqlite_autoindex_supplier_return_lines_1',
  },
  {
    name: 'ledger by party',
    sql: 'SELECT amount FROM ledger_entries WHERE tenant_id = ? AND party_type = ? AND party_id = ? ORDER BY created_at',
    args: ['t', 'customer', 'c'],
    index: 'ledger_party',
  },
  {
    name: 'refund ledger rows',
    sql: "SELECT source_id FROM ledger_entries WHERE tenant_id = ? AND source_type = 'refund' AND source_id IN (?)",
    args: ['t', 'r'],
    index: 'ledger_source',
  },
  {
    name: 'stock on hand',
    sql: 'SELECT SUM(qty_delta_milli) FROM stock_movements WHERE tenant_id = ? AND product_id = ?',
    args: ['t', 'p'],
    index: 'stock_movements_product',
  },
  {
    name: 'sales by business date',
    sql: 'SELECT id FROM sales WHERE tenant_id = ? AND business_date BETWEEN ? AND ?',
    args: ['t', '2026-01-01', '2026-12-31'],
    index: 'sales_date',
  },
  {
    name: 'audit by time',
    sql: 'SELECT id FROM audit_log WHERE tenant_id = ? AND created_at BETWEEN ? AND ?',
    args: ['t', 0, 1],
    index: 'audit_log_time',
  },
];

const REFERENCE_LINES = 3;
const UNIT = 100_000;
const TOTAL = REFERENCE_LINES * UNIT;

/** sale + 3 lines + payment + udhaar ledger + 3 stock movements, one transaction. */
function referenceSaleOps(
  shop: Awaited<ReturnType<typeof seedShop>>,
  seq: number,
) {
  const now = Date.now();
  const id = newId(now + seq);
  const tx = newId(now + seq);
  const sale = {
    id,
    invoice_no: `INV-${shop.till.code}-${seq}`,
    invoice_seq: seq,
    branch_id: shop.branchId,
    device_id: shop.till.id,
    staff_id: IDS.cashier,
    customer_id: IDS.customer,
    business_date: '2026-10-27',
    created_at: now,
    line_count: REFERENCE_LINES,
    items_qty_milli: 3000,
    gross_total: TOTAL,
    item_discount_total: 0,
    subtotal: TOTAL,
    bill_discount_type: null,
    bill_discount_value: 0,
    bill_discount: 0,
    tax_rate_bp: 0,
    tax: 0,
    tax_inclusive: 0,
    rounding: 0,
    total: TOTAL,
    paid_total: 150_000,
    udhaar_amount: 150_000,
    cash_tendered: 150_000,
    change_given: 0,
    replaces_sale_id: null,
    note: '',
  };
  const ops = [op('sales', 'insert', sale, { tx_id: tx })];
  for (let n = 1; n <= REFERENCE_LINES; n += 1)
    ops.push(
      op(
        'sale_lines',
        'insert',
        {
          id: newId(now + seq + n),
          sale_id: id,
          line_no: n,
          product_id: IDS.product,
          name_snapshot: 'Reference phone',
          sku_snapshot: 'PHN-0001',
          qty_milli: 1000,
          unit_price: UNIT,
          gross: UNIT,
          discount_type: null,
          discount_value: 0,
          discount: 0,
          net: UNIT,
          bill_discount_alloc: 0,
          tax_alloc: 0,
          rounding_alloc: 0,
          unit_cost_snapshot: 50_000,
          below_cost: 0,
          serial: '',
          warranty_until: null,
          created_at: now,
        },
        { tx_id: tx },
      ),
    );
  ops.push(
    op(
      'payments',
      'insert',
      {
        id: newId(now + seq + 10),
        direction: 'in',
        method: 'cash',
        purpose: 'sale',
        amount: 150_000,
        cash_tendered: 150_000,
        change_given: 0,
        reference: '',
        sale_id: id,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: null,
        party_id: null,
        note: '',
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.cashier,
        business_date: '2026-10-27',
        created_at: now,
      },
      { tx_id: tx },
    ),
    op(
      'ledger_entries',
      'insert',
      {
        id: newId(now + seq + 11),
        party_type: 'customer',
        party_id: IDS.customer,
        amount: 150_000,
        source_type: 'sale',
        source_id: id,
        note: '',
        branch_id: shop.branchId,
        device_id: shop.till.id,
        staff_id: IDS.cashier,
        business_date: '2026-10-27',
        created_at: now,
      },
      { tx_id: tx },
    ),
  );
  for (let n = 0; n < REFERENCE_LINES; n += 1)
    ops.push(
      op(
        'stock_movements',
        'insert',
        {
          id: newId(now + seq + 20 + n),
          product_id: IDS.product,
          qty_delta_milli: -1000,
          reason_code: 'sale',
          ref_type: 'sale',
          ref_id: id,
          unit_cost: null,
          note: '',
          branch_id: shop.branchId,
          device_id: shop.till.id,
          staff_id: IDS.cashier,
          business_date: '2026-10-27',
          created_at: now,
        },
        { tx_id: tx },
      ),
    );
  return ops;
}

describe('T-062 performance', () => {
  it('uses a tenant-leading index for every hot Worker query', async () => {
    for (const query of HOT_QUERIES) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.args)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail).join('\n');
      expect(details, query.name).toContain(query.index);
      expect(details, query.name).toContain('tenant_id');
    }
  });

  it('measures the real row budget of 150 reference bills in two shops', async () => {
    const a = await seedShop('Perf A', { budget: 100_000 });
    const b = await seedShop('Perf B', { budget: 100_000 });
    const today = new Date().toISOString().slice(0, 10);
    for (const shop of [a, b]) {
      // 9 ops per bill, so 20 bills (180 ops) per push.
      const applied = [];
      for (let first = 0; first < 150; first += 20) {
        const ops = Array.from({ length: Math.min(20, 150 - first) }, (_, i) =>
          referenceSaleOps(shop, first + i + 1),
        ).flat();
        const res = await pushOk(shop.till, ops);
        expect(res.results).toHaveLength(ops.length);
        expect(res.results.every((row) => row.result === 'applied')).toBe(true);
        applied.push(...res.results);
      }
      expect(applied).toHaveLength(150 * 9);
      const usage = await env.DB.prepare(
        'SELECT rows_written FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
      )
        .bind(shop.tenantId, today)
        .first<{ rows_written: number }>();
      // 150 reference bills incl. indexes and change_log must fit daily_write_budget (D-076).
      expect(usage, shop.slug).toBeDefined();
      // T-062 measured ~117 rows/bill with indexes, not the old 28 estimate.
      expect(Number(usage?.rows_written ?? 0)).toBeGreaterThan(10_000);
      expect(Number(usage?.rows_written ?? 0)).toBeLessThanOrEqual(25_000);
    }
  }, 60_000);
});
