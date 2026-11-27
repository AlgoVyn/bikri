import { env } from 'cloudflare:workers';
import { businessDate, newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { tenantDeleteChunkSql } from '../src/db/tenantDelete.ts';
import { IDS, json, seedShop } from './helpers/fixtures.ts';
import { op, productRow, push, pushOk, quoteOps } from './helpers/ops.ts';

// T-062: two large tenants, the documented write budget and the hot-query plans.

const HOT_QUERIES: Array<{
  name: string;
  sql: string;
  args: unknown[];
  index: string;
  /** The token lookup is globally unique and legally has no tenant-leading key. */
  tenantLeading?: boolean;
  /** Assert the plan has no sort step (for the H8 pagination statements). */
  noTempBTree?: boolean;
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
    name: 'payments for a day close',
    sql: 'SELECT id FROM payments WHERE tenant_id = ? AND device_id = ? AND created_at > ? AND created_at <= ?',
    args: ['t', 'd', 0, 1],
    index: 'payments_device_created',
  },
  {
    name: 'cash moves for a day close',
    sql: 'SELECT id FROM cash_moves WHERE tenant_id = ? AND device_id = ? AND created_at > ? AND created_at <= ?',
    args: ['t', 'd', 0, 1],
    index: 'cash_moves_device_created',
  },
  {
    name: 'expenses for a day close',
    sql: 'SELECT id FROM expenses WHERE tenant_id = ? AND device_id = ? AND created_at > ? AND created_at <= ?',
    args: ['t', 'd', 0, 1],
    index: 'expenses_device_created',
  },
  {
    name: 'payments by supplier return',
    sql: 'SELECT id FROM payments WHERE tenant_id = ? AND supplier_return_id = ?',
    args: ['t', 'r'],
    index: 'payments_supplier_return',
  },
  {
    name: 'payments by purchase',
    sql: 'SELECT id FROM payments WHERE tenant_id = ? AND purchase_id = ?',
    args: ['t', 'p'],
    index: 'payments_purchase',
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
    name: 'quotation lines by quote',
    sql: 'SELECT id FROM quotation_lines WHERE tenant_id = ? AND quote_id IN (?)',
    args: ['t', 'q'],
    index: 'sqlite_autoindex_quotation_lines_1',
  },
  {
    name: 'ledger by party',
    sql: 'SELECT amount FROM ledger_entries WHERE tenant_id = ? AND party_type = ? AND party_id = ?',
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
    name: 'sale movements for a refund',
    sql: "SELECT ref_id FROM stock_movements WHERE tenant_id = ? AND ref_id = ? AND reason_code = 'sale'",
    args: ['t', 's'],
    index: 'stock_movements_ref',
  },
  {
    name: 'branch device codes',
    sql: 'SELECT device_code FROM branch_device_codes WHERE tenant_id = ? AND branch_id = ?',
    args: ['t', 'b'],
    index: 'sqlite_autoindex_branch_device_codes_1',
  },
  {
    name: 'tenant status history',
    sql: "SELECT after_json FROM audit_log WHERE tenant_id = ? AND action = 'tenant_status_change' ORDER BY created_at DESC LIMIT 50",
    args: ['t'],
    index: 'audit_log_status',
  },
  {
    name: 'purge replacement sales',
    sql: 'DELETE FROM sales WHERE tenant_id = ?1 AND replaces_sale_id IS NOT NULL AND id IN (SELECT id FROM sales WHERE tenant_id = ?1 AND replaces_sale_id IS NOT NULL ORDER BY id DESC LIMIT ?2)',
    args: ['t', 2000],
    index: 'sales_replaces',
    noTempBTree: true,
  },
  {
    name: 'last close per device',
    sql: 'SELECT device_id AS id, id AS close_id, period_end, counted_cash FROM day_closes WHERE tenant_id = ? AND device_id = ? ORDER BY period_end DESC LIMIT 1',
    args: ['t', 'd'],
    index: 'day_closes_device',
    noTempBTree: true,
  },
  {
    name: 'device by token hash',
    sql: 'SELECT d.*, t.slug, u.pushes FROM devices d JOIN tenants t ON t.id = d.tenant_id LEFT JOIN tenant_usage u ON u.tenant_id = t.id AND u.day = ?2 WHERE d.token_hash = ?1',
    args: ['h', '2026-01-01'],
    index: 'sqlite_autoindex_devices_1',
    tenantLeading: false,
  },
  {
    name: 'already applied ops',
    sql: 'SELECT op_id, result, error_code FROM applied_ops WHERE tenant_id = ?1 AND op_id IN (?)',
    args: ['t', 'o'],
    index: 'sqlite_autoindex_applied_ops_1',
    noTempBTree: true,
  },
  {
    name: 'latest change seq',
    sql: 'SELECT MAX(seq) AS seq FROM change_log WHERE tenant_id = ?1',
    args: ['t'],
    index: 'change_log_tenant_seq',
    noTempBTree: true,
  },
  {
    name: 'sale lines by sale',
    sql: 'SELECT id, sale_id FROM sale_lines WHERE tenant_id = ?1 AND sale_id IN (?)',
    args: ['t', 's'],
    index: 'sqlite_autoindex_sale_lines_1',
    noTempBTree: true,
  },
  {
    name: 'sale void by sale',
    sql: 'SELECT sale_id AS id FROM sale_voids WHERE tenant_id = ?1 AND sale_id IN (?)',
    args: ['t', 's'],
    index: 'sqlite_autoindex_sale_voids_1',
    noTempBTree: true,
  },
  {
    name: 'void payments by sale',
    sql: "SELECT sale_id AS id, direction, purpose, method, amount FROM payments WHERE tenant_id = ?1 AND purpose = 'void' AND sale_id IN (?)",
    args: ['t', 's'],
    index: 'payments_sale',
    noTempBTree: true,
  },
  {
    name: 'quotation by id',
    sql: 'SELECT id FROM quotations WHERE tenant_id = ?1 AND id IN (?)',
    args: ['t', 'q'],
    index: 'sqlite_autoindex_quotations_2',
    noTempBTree: true,
  },
  {
    name: 'purchase lines by id',
    sql: 'SELECT pl.id AS id, pu.supplier_id AS supplier_id FROM purchase_lines pl JOIN purchases pu ON pu.tenant_id = ?1 AND pu.id = pl.purchase_id WHERE pl.tenant_id = ?1 AND pl.id IN (?)',
    args: ['t', 'p'],
    index: 'sqlite_autoindex_purchase_lines_2',
    noTempBTree: true,
  },
  {
    name: 'sale status update',
    sql: 'UPDATE sales SET status = ?2 WHERE tenant_id = ?1 AND id = ?3',
    args: ['t', 'refunded', 's'],
    index: 'sqlite_autoindex_sales_2',
    noTempBTree: true,
  },
  {
    name: 'prune watermark today',
    sql: `INSERT INTO change_log_watermarks (tenant_id, day, max_seq)
      SELECT ?1, ?2, COALESCE((SELECT MAX(seq) FROM change_log WHERE tenant_id = ?1), 0)
      WHERE COALESCE((SELECT MAX(seq) FROM change_log WHERE tenant_id = ?1), 0) >
        COALESCE((SELECT max_seq FROM change_log_watermarks WHERE tenant_id = ?1 ORDER BY day DESC LIMIT 1), -1)
      ON CONFLICT(tenant_id, day) DO UPDATE SET max_seq = excluded.max_seq`,
    args: ['t', '2026-01-01'],
    index: 'change_log_tenant_seq',
  },
  {
    name: 'prune cutoff watermark',
    sql: 'SELECT max_seq FROM change_log_watermarks WHERE tenant_id = ?1 AND day <= ?2 ORDER BY day DESC LIMIT 1',
    args: ['t', '2026-01-01'],
    index: 'sqlite_autoindex_change_log_watermarks_1',
    noTempBTree: true,
  },
  {
    name: 'prune expired enrolment codes',
    sql: 'DELETE FROM enrolment_codes WHERE expires_at < ?1',
    args: [0],
    index: 'enrolment_codes_expiry',
    tenantLeading: false,
    noTempBTree: true,
  },
  {
    name: 'prune expired owner codes',
    sql: 'DELETE FROM owner_email_codes WHERE expires_at < ?1',
    args: [0],
    index: 'owner_email_codes_expiry',
    tenantLeading: false,
    noTempBTree: true,
  },
  {
    name: 'prune old watermarks',
    sql: 'DELETE FROM change_log_watermarks WHERE day < ?1',
    args: ['2026-01-01'],
    index: 'change_log_watermarks_day',
    tenantLeading: false,
    noTempBTree: true,
  },
  {
    name: 'owner email codes by time',
    sql: 'SELECT device_id, created_at, attempts, used_at, expires_at FROM owner_email_codes WHERE tenant_id = ?1 AND created_at > ?2 ORDER BY created_at DESC',
    args: ['t', 0],
    index: 'owner_email_codes_time',
    noTempBTree: true,
  },
  {
    name: 'open enrolment codes',
    sql: "SELECT code_hash, device_name, grants_admin, expires_at, created_at FROM enrolment_codes WHERE tenant_id = ?1 AND used_at IS NULL AND expires_at > ?2 AND kind = 'till' ORDER BY created_at",
    args: ['t', 0],
    index: 'enrolment_codes_tenant',
  },
  {
    name: 'public shop requests',
    sql: 'SELECT id FROM shop_requests WHERE status = ?1 ORDER BY created_at DESC LIMIT 50',
    args: ['pending'],
    index: 'shop_requests_status',
    tenantLeading: false,
  },
  {
    name: 'tenant devices',
    sql: 'SELECT * FROM devices WHERE tenant_id = ?1 ORDER BY revoked_at IS NOT NULL, enrolled_at',
    args: ['t'],
    index: 'sqlite_autoindex_devices_3',
  },
  {
    name: 'open sync conflicts',
    sql: "SELECT id FROM sync_conflicts WHERE tenant_id = ?1 AND resolution = 'needs_owner'",
    args: ['t'],
    index: 'sync_conflicts_open',
    noTempBTree: true,
  },
  {
    name: 'bundle rows by bundle',
    sql: 'SELECT id FROM bundle_items WHERE tenant_id = ? AND bundle_id IN (?)',
    args: ['t', 'b'],
    index: 'bundle_items_by_bundle',
  },
  {
    name: 'bundle rows by component',
    sql: 'SELECT id FROM bundle_items WHERE tenant_id = ? AND component_product_id IN (?)',
    args: ['t', 'p'],
    index: 'bundle_items_by_component',
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
    staff_id: IDS.owner,
    customer_id: IDS.customer,
    business_date: businessDate(now),
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
        business_date: businessDate(now),
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
        business_date: businessDate(now),
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
          business_date: businessDate(now),
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
      if (query.tenantLeading !== false)
        expect(details, query.name).toContain('tenant_id');
      if (query.noTempBTree)
        expect(details, query.name).not.toContain('TEMP B-TREE');
    }
  });

  it('pages purge and tenant deletes by the tenant-leading key', async () => {
    const cases: Array<{
      tbl: string;
      where: string;
      index: string;
      tenantEquality?: string;
    }> = [
      {
        tbl: 'sales',
        where: 'replaces_sale_id IS NOT NULL',
        index: 'sqlite_autoindex_sales_2',
      },
      {
        tbl: 'change_log',
        where: '1 = 1',
        index: 'change_log_tenant_seq',
        tenantEquality: '(tenant_id=? AND seq=?)',
      },
      {
        tbl: 'applied_ops',
        where: '1 = 1',
        index: 'sqlite_autoindex_applied_ops_1',
        tenantEquality: '(tenant_id=? AND op_id=?)',
      },
      {
        tbl: 'change_log_watermarks',
        where: '1 = 1',
        index: 'sqlite_autoindex_change_log_watermarks_1',
        tenantEquality: '(tenant_id=? AND day=?)',
      },
      {
        tbl: 'branch_device_codes',
        where: '1 = 1',
        index: 'sqlite_autoindex_branch_device_codes_1',
        tenantEquality: '(tenant_id=? AND branch_id=? AND device_code=?)',
      },
      {
        tbl: 'enrolment_codes',
        where: '1 = 1',
        index: 'enrolment_codes_tenant',
        tenantEquality: '(tenant_id=? AND expires_at=?)',
      },
    ];
    for (const testCase of cases) {
      const plan = await env.DB.prepare(
        `EXPLAIN QUERY PLAN ${tenantDeleteChunkSql(testCase.tbl, testCase.where)}`,
      )
        .bind('t', 2_000)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail).join('\n');
      expect(details, testCase.tbl).toContain(testCase.index);
      expect(details, testCase.tbl).not.toContain('TEMP B-TREE');
      if (testCase.tenantEquality)
        expect(details, testCase.tbl).toContain(testCase.tenantEquality);
    }
  });

  it('measures the real row budget of 150 reference bills in two shops', async () => {
    const a = await seedShop('Perf A', { budget: 100_000 });
    const b = await seedShop('Perf B', { budget: 100_000 });
    const today = new Date().toISOString().slice(0, 10);
    for (const shop of [a, b]) {
      // Reference bills snapshot the catalogue cost; keep the seeded product in step.
      await env.DB.prepare(
        'UPDATE products SET avg_cost = 50000, last_cost = 50000 WHERE tenant_id = ?1 AND id = ?2',
      )
        .bind(shop.tenantId, IDS.product)
        .run();
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
      // T-062 measured ~127 rows/bill including the D-225 stock-cache trigger.
      // D-231 dropped 16 indexes no server query uses and added 4 hot-path ones;
      // the reference bill is now ~97 rows. The default budget is 19,500, so a
      // regression above 130 rows/bill must fail here.
      expect(Number(usage?.rows_written ?? 0)).toBeGreaterThan(12_000);
      expect(Number(usage?.rows_written ?? 0)).toBeLessThanOrEqual(19_500);
    }
  }, 60_000);

  it('reads the server stock cache instead of a product’s whole movement history', async () => {
    const shop = await seedShop('Perf history', { budget: 100_000 });
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const day = businessDate(now);
    // 20,000 stored movements for one product, written directly (operator import shape).
    // The old push summed this history for every referenced product on every bill.
    for (let chunk = 0; chunk < 10; chunk += 1) {
      await env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000
         )
         INSERT INTO stock_movements
           (tenant_id, id, product_id, qty_delta_milli, reason_code, ref_type, ref_id,
            unit_cost, note, branch_id, device_id, staff_id, business_date, created_at)
         SELECT ?1, printf('MV%06d', ?5 + n), ?3, 1, 'entry_fix', 'adjustment', NULL,
           NULL, '', ?4, ?6, ?7, ?8, ?9
         FROM seq`,
      )
        .bind(
          shop.tenantId,
          chunk,
          IDS.product,
          shop.branchId,
          chunk * 2_000,
          shop.till.id,
          IDS.owner,
          day,
          now,
        )
        .run();
    }
    expect(
      (
        await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ?1 AND product_id = ?2',
        )
          .bind(shop.tenantId, IDS.product)
          .first<{ n: number }>()
      )?.n,
    ).toBe(20_000);
    // The reference bill snapshots the catalogue cost.
    await env.DB.prepare(
      'UPDATE products SET avg_cost = 50000, last_cost = 50000 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .run();
    // Measure only the push, not the fixture writes.
    await env.DB.prepare(
      'DELETE FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
    )
      .bind(shop.tenantId, today)
      .run();
    const res = await pushOk(shop.till, referenceSaleOps(shop, 900));
    expect(res.results.every((row) => row.result === 'applied')).toBe(true);
    const usage = await env.DB.prepare(
      'SELECT rows_read, rows_written FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
    )
      .bind(shop.tenantId, today)
      .first<{ rows_read: number; rows_written: number }>();
    // The old lookup read 20,000 movement rows for this one product. The cache lookup
    // keeps a 9-op reference bill in the low hundreds even with that history.
    expect(Number(usage?.rows_read ?? 0)).toBeGreaterThan(0);
    expect(Number(usage?.rows_read ?? 0)).toBeLessThan(5_000);
    expect(Number(usage?.rows_written ?? 0)).toBeGreaterThan(0);
  }, 120_000);

  it('does not read bundle recipes for a push with no bundle', async () => {
    const shop = await seedShop('Perf bundles', { budget: 100_000 });
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    // 100 bundles × 5 components = 500 active recipe rows. The old lookup read
    // all of them on every push, even a plain sale (D-231).
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100)
         INSERT INTO products (tenant_id, id, name_en, sku, price, kind, track_stock, created_at, updated_at)
         SELECT ?1, printf('bundle-%03d', x), 'Bundle', printf('B-%03d', x), 1000, 'bundle', 0, ?2, ?2 FROM n`,
      ).bind(shop.tenantId, now),
      env.DB.prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100)
         INSERT INTO products (tenant_id, id, name_en, sku, price, kind, track_stock, created_at, updated_at)
         SELECT ?1, printf('component-%03d', x), 'Component', printf('C-%03d', x), 100, 'simple', 1, ?2, ?2 FROM n`,
      ).bind(shop.tenantId, now),
      env.DB.prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100)
         INSERT INTO bundle_items (tenant_id, id, bundle_id, component_product_id, qty_milli, sort_order, created_at, updated_at)
         SELECT ?1, printf('bi-%03d-%d', x, y), printf('bundle-%03d', x),
                printf('component-%03d', ((x + y) % 100) + 1), 1000, y, ?2, ?2
         FROM n CROSS JOIN (SELECT 1 AS y UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5)`,
      ).bind(shop.tenantId, now),
    ]);
    const recipes = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM bundle_items WHERE tenant_id = ?1',
    )
      .bind(shop.tenantId)
      .first<{ n: number }>();
    expect(recipes?.n).toBe(500);
    // Reference bills snapshot the catalogue cost; keep the seeded product in step.
    await env.DB.prepare(
      'UPDATE products SET avg_cost = 50000, last_cost = 50000 WHERE tenant_id = ?1 AND id = ?2',
    )
      .bind(shop.tenantId, IDS.product)
      .run();
    await env.DB.prepare(
      'DELETE FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
    )
      .bind(shop.tenantId, today)
      .run();
    const res = await pushOk(shop.till, referenceSaleOps(shop, 1));
    expect(res.results.every((row) => row.result === 'applied')).toBe(true);
    const usage = await env.DB.prepare(
      'SELECT rows_read FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
    )
      .bind(shop.tenantId, today)
      .first<{ rows_read: number }>();
    // A 500-recipe shop must not pay for the recipes on a normal sale.
    expect(Number(usage?.rows_read ?? 0)).toBeLessThan(400);
  }, 60_000);

  it('validates a 60-line quotation in one call budget and memoised totals', async () => {
    const shop = await seedShop('Perf quote 60', { budget: 100_000 });
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const unit = 50_000;
    const lineCount = 60;
    const total = unit * lineCount;
    const base = quoteOps(shop, shop.till, 1);
    const tx = newId(now);
    const header = {
      ...base.row,
      line_count: lineCount,
      items_qty_milli: lineCount * 1000,
      gross_total: total,
      subtotal: total,
      total,
    };
    const line = {
      ...base.line,
      unit_price: unit,
      gross: unit,
      net: unit,
    };
    const ops = [
      op('quotations', 'upsert', header, { tx_id: tx, base_rev: 0 }),
      ...Array.from({ length: lineCount }, (_, index) =>
        op(
          'quotation_lines',
          'upsert',
          {
            ...line,
            id: newId(now + index + 1),
            line_no: index + 1,
            name_snapshot: `Line ${index + 1}`,
          },
          { tx_id: tx, base_rev: 0 },
        ),
      ),
    ];
    // Measure only this push, not the fixture writes.
    await env.DB.prepare(
      'DELETE FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
    )
      .bind(shop.tenantId, today)
      .run();
    const res = await push(shop.till, ops);
    expect(res.status).toBe(200);
    const body = await json<{
      results: Array<{ result: string; error_code?: string }>;
    }>(res);
    expect(body.results).toHaveLength(ops.length);
    expect(body.results.filter((row) => row.result === 'applied')).toHaveLength(
      ops.length,
    );
    // The route's test-only headers expose the D1 call budget and planning/apply CPU.
    // 3 (token/closing/spare) + alreadyApplied + the quote-line preload + the lookup
    // batch + the apply batch. The preload is counted, unlike the old sequential loops.
    expect(Number(res.headers.get('x-bikri-d1-calls'))).toBe(7);
    expect(Number(res.headers.get('x-bikri-apply-ms'))).toBeLessThan(2_000);
    // A header-only edit re-reads and validates all 60 stored lines without writing new
    // ones, so its read count is the lookup path: one page by quote id, the header and
    // the catalogue rows. Before H9 this also paid two more full-column line reads.
    await env.DB.prepare(
      'DELETE FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
    )
      .bind(shop.tenantId, today)
      .run();
    const edit = await push(shop.till, [
      op(
        'quotations',
        'upsert',
        { ...header, note: 'Updated terms' },
        { base_rev: 1, changed_fields: ['note'] },
      ),
    ]);
    expect(edit.status).toBe(200);
    const edited = await json<{ results: Array<{ result: string }> }>(edit);
    expect(edited.results[0]?.result).toBe('applied');
    const usage = await env.DB.prepare(
      'SELECT rows_read FROM tenant_usage WHERE tenant_id = ?1 AND day = ?2',
    )
      .bind(shop.tenantId, today)
      .first<{ rows_read: number }>();
    expect(Number(usage?.rows_read ?? 0)).toBeLessThan(140);
  }, 60_000);

  it('deletes reissued bills through the sales_replaces index', async () => {
    const shop = await seedShop('Perf purge', { budget: 100_000 });
    const now = Date.now();
    const day = businessDate(now);
    // 20,000 bills, 2,000 of them reissues of the first 2,000. The purge and the
    // nightly tenant delete remove the reissues first; without a child index SQLite
    // scans every bill for each deleted row (O(N²)).
    for (let chunk = 0; chunk < 10; chunk += 1) {
      await env.DB.prepare(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000
         )
         INSERT INTO sales
           (tenant_id, id, invoice_no, invoice_seq, branch_id, device_id, staff_id,
            business_date, created_at, line_count, items_qty_milli, gross_total,
            item_discount_total, subtotal, total, paid_total, replaces_sale_id)
         SELECT ?1, printf('purge-s%05d', ?2 + n), printf('PRG-%05d', ?2 + n),
           ?2 + n, ?3, ?4, ?5, ?6, ?7, 1, 1000, 100, 0, 100, 100, 100,
           CASE WHEN ?2 + n BETWEEN 2001 AND 4000
             THEN printf('purge-s%05d', ?2 + n - 2000) END
         FROM seq`,
      )
        .bind(
          shop.tenantId,
          chunk * 2_000,
          shop.branchId,
          shop.till.id,
          IDS.owner,
          day,
          now,
        )
        .run();
    }
    expect(
      (
        await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM sales WHERE tenant_id = ?1',
        )
          .bind(shop.tenantId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(20_000);
    // The append-only delete guard allows removal only while the shop is in
    // maintenance/deleting, which is exactly when purge runs.
    await env.DB.prepare(
      "UPDATE tenants SET status = 'maintenance', status_changed_at = ?2 WHERE id = ?1",
    )
      .bind(shop.tenantId, now)
      .run();

    const deleteSql = tenantDeleteChunkSql(
      'sales',
      'replaces_sale_id IS NOT NULL',
    );
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${deleteSql}`)
      .bind(shop.tenantId, 2_000)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join('\n');
    expect(details).toContain('sales_replaces');
    // The new page is a reverse tenant-leading PK scan, not a sort of every remaining
    // bill (H8). The outer delete is an index probe per page row.
    expect(details).not.toContain('TEMP B-TREE');

    const started = Date.now();
    const deleted = await env.DB.prepare(deleteSql)
      .bind(shop.tenantId, 2_000)
      .run();
    const elapsed = Date.now() - started;
    expect(deleted.meta.changes).toBe(2_000);
    // With the index the FK check reads the replacement rows, not all 20,000 bills.
    // 100k leaves headroom for index/table probes while still catching the O(N²)
    // regression (which reads tens of millions of rows and takes seconds). Older
    // local runtimes omit meta.rows_read; the plan and elapsed checks still gate it.
    const rowsRead = Number(deleted.meta.rows_read);
    if (Number.isFinite(rowsRead)) expect(rowsRead).toBeLessThan(100_000);
    expect(elapsed).toBeLessThan(2_000);
  }, 120_000);

  it('still guards a component delete while allowing a normal edit', async () => {
    const shop = await seedShop('Perf component', { budget: 100_000 });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO products (tenant_id, id, name_en, sku, price, kind, track_stock, created_at, updated_at)
         VALUES (?1, 'bundle-1', 'Bundle', 'BUNDLE-1', 1000, 'bundle', 0, ?2, ?2)`,
      ).bind(shop.tenantId, now),
      env.DB.prepare(
        `INSERT INTO bundle_items (tenant_id, id, bundle_id, component_product_id, qty_milli, sort_order, created_at, updated_at)
         VALUES (?1, 'bi-1', 'bundle-1', ?2, 1000, 0, ?3, ?3)`,
      ).bind(shop.tenantId, IDS.product, now),
    ]);
    const edit = await pushOk(shop.admin, [
      op('products', 'upsert', productRow(IDS.product, { price: 60000 }, now), {
        base_rev: 3,
        changed_fields: ['price'],
      }),
    ]);
    expect(edit.results[0]?.result).toBe('applied');
    const removed = await pushOk(shop.admin, [
      op(
        'products',
        'delete',
        { id: IDS.product },
        { base_rev: 4, updated_by: IDS.owner },
      ),
    ]);
    expect(removed.results[0]?.error_code).toBe('CONSTRAINT_FAILED');
  }, 60_000);
});
