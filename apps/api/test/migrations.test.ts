import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

// T-003: 0001_init.sql + 0002_seed.sql (docs/02-data-model.md §2) apply on local D1,
// accept one valid row per table and reject rows that break the CHECKs.

const db = env.DB;
const T = 1_793_050_000_000;
const DAY = '2026-10-27';

type Row = Record<string, string | number | null>;

function insert(tbl: string, row: Row): D1PreparedStatement {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return db.prepare(sql).bind(...Object.values(row));
}

const ledgerCtx = {
  branch_id: 'br1',
  device_id: 'dev1',
  staff_id: 'st1',
  business_date: DAY,
  created_at: T,
};
const master = { created_at: T, updated_at: T };

/** One valid row per table, in foreign-key order. */
const VALID: ReadonlyArray<readonly [string, Row]> = [
  [
    'shop',
    {
      id: 'shop',
      name: 'Algovyn Mobiles',
      business_type: 'mobile',
      phone: '+923001234567',
      address: 'Hall Road, Lahore',
      ...master,
    },
  ],
  [
    'branches',
    { id: 'br1', name: 'Main', bill_prefix: 'INV', is_default: 1, ...master },
  ],
  [
    'staff',
    {
      id: 'st1',
      name: 'Adnan',
      role: 'owner',
      pin_hash: 'aGFzaA==',
      pin_salt: 'c2FsdA==',
      ...master,
    },
  ],
  [
    'devices',
    {
      id: 'dev1',
      name: 'Counter 1',
      branch_id: 'br1',
      device_code: 'A',
      token_hash: 'ab'.repeat(32),
      enrolled_at: T,
      enrolled_by_email: 'operator@example.com',
      ...master,
    },
  ],
  [
    'enrolment_codes',
    {
      code_hash: 'cd'.repeat(32),
      device_name: 'Counter 2',
      branch_id: 'br1',
      created_by_email: 'operator@example.com',
      created_at: T,
      expires_at: T + 15 * 60_000,
    },
  ],
  [
    'change_log',
    { tbl: 'products', row_id: 'p1', op: 'upsert', row_json: '{}', at: T },
  ],
  [
    'applied_ops',
    { op_id: 'op1', device_id: 'dev1', applied_at: T, result: 'applied' },
  ],
  [
    'sync_conflicts',
    {
      id: 'sc1',
      op_id: 'op1',
      tbl: 'products',
      row_id: 'p1',
      fields_json: '{}',
      resolution: 'merged',
      at: T,
    },
  ],
  ['categories', { id: 'cat1', name_en: 'Phones', ...master }],
  [
    'products',
    {
      id: 'p1',
      name_en: 'Phone X',
      category_id: 'cat1',
      sku: 'PHO-AB12',
      price: 4_200_000,
      ...master,
    },
  ],
  [
    'product_barcodes',
    { id: 'pb1', product_id: 'p1', barcode: '8964000000011', ...master },
  ],
  [
    'customers',
    {
      id: 'cu1',
      name: 'Ali',
      phone: '+923001234567',
      credit_limit: 4_000_000,
      ...master,
    },
  ],
  ['suppliers', { id: 'su1', name: 'Hall Road Traders', ...master }],
  [
    'promises',
    {
      id: 'pr1',
      customer_id: 'cu1',
      promised_on: '2026-11-01',
      amount: 100_000,
      ...master,
    },
  ],
  [
    'sales',
    {
      id: 's1',
      invoice_no: 'INV-A-1',
      invoice_seq: 1,
      customer_id: 'cu1',
      line_count: 1,
      items_qty_milli: 1000,
      gross_total: 4_200_000,
      item_discount_total: 0,
      subtotal: 4_200_000,
      total: 4_200_000,
      paid_total: 4_000_000,
      udhaar_amount: 200_000,
      ...ledgerCtx,
    },
  ],
  [
    'sale_lines',
    {
      id: 'sl1',
      sale_id: 's1',
      line_no: 1,
      product_id: 'p1',
      name_snapshot: 'Phone X',
      qty_milli: 1000,
      unit_price: 4_200_000,
      gross: 4_200_000,
      net: 4_200_000,
      created_at: T,
    },
  ],
  [
    'refunds',
    {
      id: 'rf1',
      sale_id: 's1',
      kind: 'partial',
      reason: 'Faulty',
      method: 'cash',
      exact_amount: 300_000,
      udhaar_part: 200_000,
      amount: 100_000,
      ...ledgerCtx,
    },
  ],
  [
    'refund_lines',
    {
      id: 'rl1',
      refund_id: 'rf1',
      sale_line_id: 'sl1',
      qty_milli: 1000,
      amount: 300_000,
      created_at: T,
    },
  ],
  [
    'sale_voids',
    {
      id: 'sv1',
      sale_id: 's1',
      reason: 'Wrong item',
      device_id: 'dev1',
      staff_id: 'st1',
      business_date: DAY,
      created_at: T,
    },
  ],
  [
    'ledger_entries',
    {
      id: 'le1',
      party_type: 'customer',
      party_id: 'cu1',
      amount: 200_000,
      source_type: 'sale',
      source_id: 's1',
      ...ledgerCtx,
    },
  ],
  [
    'stock_movements',
    {
      id: 'sm1',
      product_id: 'p1',
      qty_delta_milli: -1000,
      reason_code: 'sale',
      ref_type: 'sale',
      ref_id: 's1',
      ...ledgerCtx,
    },
  ],
  [
    'purchases',
    {
      id: 'pu1',
      supplier_id: 'su1',
      total: 3_000_000,
      paid_now: 1_000_000,
      paid_method: 'cash',
      line_count: 1,
      ...ledgerCtx,
    },
  ],
  [
    'purchase_lines',
    {
      id: 'pl1',
      purchase_id: 'pu1',
      line_no: 1,
      product_id: 'p1',
      qty_milli: 1000,
      unit_cost: 3_000_000,
      line_total: 3_000_000,
      landed_unit_cost: 3_000_000,
      created_at: T,
    },
  ],
  [
    'supplier_returns',
    {
      id: 'sr1',
      supplier_id: 'su1',
      purchase_id: 'pu1',
      reason: 'Defective',
      total: 3_000_000,
      refund_received: 55_000,
      refund_method: 'cash',
      line_count: 1,
      ...ledgerCtx,
    },
  ],
  [
    'supplier_return_lines',
    {
      id: 'srl1',
      return_id: 'sr1',
      line_no: 1,
      product_id: 'p1',
      purchase_line_id: 'pl1',
      qty_milli: 1000,
      unit_credit: 3_000_000,
      line_total: 3_000_000,
      cost_snapshot: 3_000_000,
      created_at: T,
    },
  ],
  [
    'payments',
    {
      id: 'pay1',
      direction: 'in',
      method: 'cash',
      purpose: 'sale',
      amount: 4_000_000,
      cash_tendered: 4_000_000,
      change_given: 0,
      sale_id: 's1',
      ...ledgerCtx,
    },
  ],
  [
    'expenses',
    { id: 'ex1', category_id: 'tea_snacks', amount: 20_000, ...ledgerCtx },
  ],
  [
    'cash_moves',
    {
      id: 'cm1',
      kind: 'pay_in',
      amount: 500_000,
      reason: 'Float',
      ...ledgerCtx,
    },
  ],
  [
    'day_closes',
    {
      id: 'dc1',
      device_id: 'dev1',
      branch_id: 'br1',
      staff_id: 'st1',
      business_date: DAY,
      period_start: T - 86_400_000,
      period_end: T,
      opening_cash: 500_000,
      cash_sales: 4_000_000,
      udhaar_cash_in: 0,
      pay_ins: 500_000,
      supplier_cash_in: 55_000,
      cash_refunds: 100_000,
      cash_expenses: 20_000,
      supplier_cash_out: 1_000_000,
      pay_outs: 0,
      expected_cash: 3_935_000,
      counted_cash: 3_931_000,
      difference: -4_000,
      created_at: T,
    },
  ],
  [
    'audit_log',
    {
      id: 'au1',
      action: 'sale_void',
      entity: 'sales',
      entity_id: 's1',
      device_id: 'dev1',
      staff_id: 'st1',
      created_at: T,
    },
  ],
];

const SERVER_TABLES = [
  'meta',
  'change_log',
  'applied_ops',
  'sync_conflicts',
  'devices',
  'enrolment_codes',
];
const EXPECTED_TABLES = [
  ...new Set([
    ...SERVER_TABLES,
    ...VALID.map(([tbl]) => tbl),
    'expense_categories',
  ]),
].sort();

async function expectRejected(
  stmt: D1PreparedStatement,
  pattern: RegExp,
): Promise<void> {
  await expect(stmt.run()).rejects.toThrow(pattern);
}

/** Storage persists across tests in one file, so insert the valid rows once. */
async function insertValidRows(): Promise<void> {
  const shop = await db
    .prepare('SELECT COUNT(*) AS n FROM shop')
    .first<{ n: number }>();
  if ((shop?.n ?? 0) > 0) return;
  await db.batch(VALID.map(([tbl, row]) => insert(tbl, row)));
}

describe('D1 migrations (T-003)', () => {
  it('creates exactly the tables in 02 §2, all STRICT', async () => {
    const { results } = await db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
      )
      .all<{ name: string; sql: string }>();
    expect(results.map((r) => r.name)).toEqual(EXPECTED_TABLES);
    for (const r of results) {
      expect(r.sql, r.name).toMatch(/\)\s*STRICT\s*$/);
    }
  });

  it('seeds meta and the 8 system expense categories (no supplier category, D-016)', async () => {
    const meta = await db
      .prepare('SELECT key, value FROM meta ORDER BY key')
      .all<{ key: string; value: string }>();
    expect(
      Object.fromEntries(meta.results.map((r) => [r.key, r.value])),
    ).toEqual({
      change_log_floor: '0',
      restore_epoch: '1',
      restore_point_at: '0',
      schema_version: '1',
      writes_date: '',
      writes_today: '0',
    });
    const cats = await db
      .prepare(
        'SELECT code FROM expense_categories WHERE is_system = 1 ORDER BY sort_order',
      )
      .all<{ code: string }>();
    expect(cats.results.map((r) => r.code)).toEqual([
      'electricity',
      'tea_snacks',
      'transport',
      'salary',
      'rent',
      'repairs',
      'internet_phone',
      'other',
    ]);
  });

  it('accepts one valid row in every table', async () => {
    await insertValidRows();
    for (const tbl of EXPECTED_TABLES) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM ${tbl}`)
        .first<{ n: number }>();
      expect(row?.n, tbl).toBeGreaterThan(0);
    }
  });

  describe('CHECK constraints', () => {
    beforeAll(insertValidRows);

    it('rejects a day close whose expected cash does not follow the formula (07 §9)', async () => {
      const [, base] = VALID.find(([t]) => t === 'day_closes') ?? ['', {}];
      // Leaving out supplier_cash_in (the Dukaan bug) must fail.
      await expectRejected(
        insert('day_closes', {
          ...base,
          id: 'dc2',
          expected_cash: 3_880_000,
          difference: 51_000,
        }),
        /CHECK constraint failed/,
      );
      await expectRejected(
        insert('day_closes', { ...base, id: 'dc3', difference: 0 }),
        /CHECK constraint failed/,
      );
    });

    it('rejects a sale whose payments do not add up to the total', async () => {
      const [, base] = VALID.find(([t]) => t === 'sales') ?? ['', {}];
      await expectRejected(
        insert('sales', {
          ...base,
          id: 's2',
          invoice_no: 'INV-A-2',
          invoice_seq: 2,
          paid_total: 4_200_000,
        }),
        /CHECK constraint failed/,
      );
      await expectRejected(
        insert('sales', {
          ...base,
          id: 's3',
          invoice_no: 'INV-A-3',
          invoice_seq: 3,
          total: 4_100_000,
        }),
        /CHECK constraint failed/,
      );
    });

    it('rejects a refund whose amount is not exact − udhaar part + rounding', async () => {
      const [, base] = VALID.find(([t]) => t === 'refunds') ?? ['', {}];
      await expectRejected(
        insert('refunds', { ...base, id: 'rf2', amount: 300_000 }),
        /CHECK constraint failed/,
      );
      // method must be NULL exactly when nothing is paid back (D-046)
      await expectRejected(
        insert('refunds', {
          ...base,
          id: 'rf3',
          udhaar_part: 300_000,
          amount: 0,
        }),
        /CHECK constraint failed/,
      );
    });

    it('rejects bad master rows, enums and STRICT type mismatches', async () => {
      await expectRejected(
        insert('shop', {
          id: 'other',
          name: 'X',
          business_type: 'mobile',
          phone: '',
          address: 'A',
          ...master,
        }),
        /CHECK constraint failed/,
      );
      await expectRejected(
        insert('branches', {
          id: 'br2',
          name: 'B',
          bill_prefix: 'inv',
          ...master,
        }),
        /CHECK constraint failed/,
      );
      await expectRejected(
        insert('payments', {
          id: 'pay2',
          direction: 'in',
          method: 'cheque',
          purpose: 'sale',
          amount: 1,
          ...ledgerCtx,
        }),
        /CHECK constraint failed/,
      );
      await expectRejected(
        insert('products', {
          id: 'p2',
          name_en: 'Cable',
          sku: 'CAB-0001',
          price: 'free',
          ...master,
        }),
        /cannot store TEXT value in INTEGER column/,
      );
      await expectRejected(
        insert('purchases', {
          id: 'pu2',
          supplier_id: 'su1',
          total: 100,
          paid_now: 50,
          line_count: 1,
          ...ledgerCtx,
        }),
        /CHECK constraint failed/,
      );
    });

    it('enforces unique SKU among non-deleted rows only', async () => {
      await expectRejected(
        insert('products', {
          id: 'p3',
          name_en: 'Dup',
          sku: 'PHO-AB12',
          price: 1,
          ...master,
        }),
        /UNIQUE constraint failed/,
      );
      await db
        .prepare('UPDATE products SET deleted_at = ? WHERE id = ?')
        .bind(T, 'p1')
        .run();
      await insert('products', {
        id: 'p4',
        name_en: 'Reuse',
        sku: 'PHO-AB12',
        price: 1,
        ...master,
      }).run();
    });

    it('enforces foreign keys', async () => {
      await expectRejected(
        insert('sale_lines', {
          id: 'sl9',
          sale_id: 'missing',
          line_no: 1,
          name_snapshot: 'X',
          qty_milli: 1000,
          unit_price: 1,
          gross: 1,
          net: 1,
          created_at: T,
        }),
        /FOREIGN KEY constraint failed/,
      );
    });
  });
});
