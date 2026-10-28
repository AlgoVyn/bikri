import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { seedShop } from './helpers/fixtures.ts';
import { pushOk, saleOps } from './helpers/ops.ts';

// T-062: two large tenants, the documented write budget and the hot-query plans.

const HOT_QUERIES: Array<{ name: string; sql: string; args: unknown[] }> = [
  {
    name: 'change_log pull',
    sql: 'SELECT seq FROM change_log WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT 500',
    args: ['t', 0],
  },
  {
    name: 'snapshot page',
    sql: 'SELECT id FROM sales WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT 500',
    args: ['t', '0'],
  },
  {
    name: 'staff lookup',
    sql: 'SELECT id FROM staff WHERE tenant_id = ?',
    args: ['t'],
  },
  {
    name: 'branch lookup',
    sql: 'SELECT id FROM branches WHERE tenant_id = ?',
    args: ['t'],
  },
  {
    name: 'product by id',
    sql: 'SELECT id FROM products WHERE tenant_id = ? AND id = ?',
    args: ['t', 'p'],
  },
  {
    name: 'sale by id',
    sql: 'SELECT id FROM sales WHERE tenant_id = ? AND id = ?',
    args: ['t', 's'],
  },
  {
    name: 'refunds by sale',
    sql: 'SELECT id FROM refunds WHERE tenant_id = ? AND sale_id = ?',
    args: ['t', 's'],
  },
  {
    name: 'payments by refund',
    sql: 'SELECT id FROM payments WHERE tenant_id = ? AND refund_id = ?',
    args: ['t', 'r'],
  },
  {
    name: 'payments by supplier return',
    sql: 'SELECT id FROM payments WHERE tenant_id = ? AND supplier_return_id = ?',
    args: ['t', 'r'],
  },
  {
    name: 'expenses by reversal',
    sql: 'SELECT id FROM expenses WHERE tenant_id = ? AND reverses_id = ?',
    args: ['t', 'e'],
  },
  {
    name: 'return lines by return',
    sql: 'SELECT id FROM supplier_return_lines WHERE tenant_id = ? AND return_id = ?',
    args: ['t', 'r'],
  },
  {
    name: 'ledger by party',
    sql: 'SELECT amount FROM ledger_entries WHERE tenant_id = ? AND party_type = ? AND party_id = ? ORDER BY created_at',
    args: ['t', 'customer', 'c'],
  },
  {
    name: 'stock on hand',
    sql: 'SELECT SUM(qty_delta_milli) FROM stock_movements WHERE tenant_id = ? AND product_id = ?',
    args: ['t', 'p'],
  },
  {
    name: 'sales by business date',
    sql: 'SELECT id FROM sales WHERE tenant_id = ? AND business_date BETWEEN ? AND ?',
    args: ['t', '2026-01-01', '2026-12-31'],
  },
  {
    name: 'audit by time',
    sql: 'SELECT id FROM audit_log WHERE tenant_id = ? AND created_at BETWEEN ? AND ?',
    args: ['t', 0, 1],
  },
];

describe('T-062 performance', () => {
  it('uses a tenant-leading index for every hot Worker query', async () => {
    for (const query of HOT_QUERIES) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.args)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail).join('\n');
      expect(details, query.name).toMatch(/USING (?:COVERING )?INDEX/u);
      expect(details, query.name).toContain('tenant_id');
    }
  });

  it('two reference shops stay inside the 7,000-row daily budget for 150 bills each', async () => {
    const a = await seedShop('Perf A');
    const b = await seedShop('Perf B');
    for (const shop of [a, b]) {
      // 200 ops per push, so 75 bills (sale + line) at a time.
      for (let first = 1; first <= 150; first += 75) {
        const ops = Array.from({ length: 75 }, (_, index) =>
          saleOps(shop, shop.till, first + index),
        ).flat();
        await pushOk(shop.till, ops);
      }
      const usage = await env.DB.prepare(
        'SELECT rows_written FROM tenant_usage WHERE tenant_id = ?1',
      )
        .bind(shop.tenantId)
        .first<{ rows_written: number }>();
      // 150 bills incl. indexes and change_log must fit daily_write_budget (D-076).
      expect(Number(usage?.rows_written ?? 0)).toBeGreaterThan(0);
      expect(Number(usage?.rows_written ?? 0)).toBeLessThanOrEqual(7_000);
    }
  }, 60_000);
});
