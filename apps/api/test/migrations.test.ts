import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_TABLES, TENANT_TABLES } from '../src/db/tenantDb.ts';

// T-008 (was T-003): the multi-tenant 0001_init.sql + 0002_seed.sql (docs/02-data-model.md §2)
// apply on local D1, accept one valid row per table in each of two tenants that use the SAME ids,
// SKUs, barcodes, bill prefixes and invoice numbers, keep uniques per tenant, reject a reference
// to another tenant's row (composite FK), and reject rows that break the CHECKs.

const db = env.DB;
const T = 1_793_050_000_000;
const DAY = '2026-10-27';

type Row = Record<string, string | number | null>;

type TenantFixture = {
  id: string;
  slug: string;
  shopName: string;
  tokenHash: string;
  codeHash: string;
};

const A: TenantFixture = {
  id: '01JTENANTAAAAAAAAAAAAAAAAA',
  slug: 'algovyn-mobiles',
  shopName: 'Algovyn Mobiles',
  tokenHash: 'ab'.repeat(32),
  codeHash: 'cd'.repeat(32),
};
const B: TenantFixture = {
  id: '01JTENANTBBBBBBBBBBBBBBBBB',
  slug: 'hall-road-electronics',
  shopName: 'Hall Road Electronics',
  tokenHash: 'ef'.repeat(32),
  codeHash: '01'.repeat(32),
};

function insert(tbl: string, row: Row): D1PreparedStatement {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return db.prepare(sql).bind(...Object.values(row));
}

function tenantRow(t: TenantFixture): Row {
  return {
    id: t.id,
    slug: t.slug,
    display_name: t.shopName,
    restore_epoch: String(T),
    created_by_email: 'operator@example.com',
    owner_email: `owner@${t.slug}.pk`,
    created_at: T,
    updated_at: T,
  };
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
function validRows(t: TenantFixture): ReadonlyArray<readonly [string, Row]> {
  return [
    [
      'shop',
      {
        id: 'shop',
        name: t.shopName,
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
        pin_hash: 'a'.repeat(44),
        pin_salt: 'a'.repeat(24),
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
        token_hash: t.tokenHash,
        is_admin: 1,
        enrolled_at: T,
        enrolled_by: 'operator:operator@example.com',
        ...master,
      },
    ],
    ['branch_device_codes', { branch_id: 'br1', device_code: 'A' }],
    [
      'enrolment_codes',
      {
        code_hash: t.codeHash,
        device_name: 'Counter 2',
        branch_id: 'br1',
        created_by: 'operator:operator@example.com',
        created_at: T,
        expires_at: T + 15 * 60_000,
      },
    ],
    [
      'owner_email_codes',
      {
        id: 'oec1',
        device_id: 'dev1',
        staff_id: 'st1',
        code_hash: t.codeHash,
        created_at: T,
        expires_at: T + 10 * 60_000,
      },
    ],
    [
      'change_log',
      { tbl: 'products', row_id: 'p1', op: 'upsert', row_json: '{}', at: T },
    ],
    [
      'applied_tx',
      {
        tx_id: 'tx1',
        device_id: 'dev1',
        applied_at: T,
        result: 'applied',
        results_json: '[]',
      },
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
      'expense_categories',
      {
        id: 'tea_snacks',
        code: 'tea_snacks',
        name_en: 'Tea & snacks',
        is_system: 1,
        sort_order: 2,
        created_at: 0,
        updated_at: 0,
      },
    ],
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
      'products',
      {
        id: 'p2',
        name_en: 'Starter Pack',
        sku: 'BND-START',
        kind: 'bundle',
        track_stock: 0,
        price: 4_500_000,
        ...master,
      },
    ],
    [
      'product_barcodes',
      { id: 'pb1', product_id: 'p1', barcode: '8964000000011', ...master },
    ],
    [
      'bundle_items',
      {
        id: 'bi1',
        bundle_id: 'p2',
        component_product_id: 'p1',
        qty_milli: 1000,
        sort_order: 0,
        ...master,
      },
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
      'quotations',
      {
        id: 'q1',
        quote_no: 'QTN-A-1',
        quote_seq: 1,
        branch_id: 'br1',
        device_id: 'dev1',
        staff_id: 'st1',
        customer_id: 'cu1',
        customer_name: 'Customer',
        customer_phone: '+923001234567',
        business_date: DAY,
        valid_until: DAY,
        status: 'open',
        line_count: 1,
        items_qty_milli: 1000,
        gross_total: 1000,
        item_discount_total: 0,
        subtotal: 1000,
        bill_discount_type: null,
        bill_discount_value: 0,
        bill_discount: 0,
        tax_rate_bp: 0,
        tax: 0,
        tax_inclusive: 0,
        round_total_to: 1,
        rounding: 0,
        total: 1000,
        note: '',
        converted_sale_id: null,
        converted_at: null,
        cancelled_reason: '',
        cancelled_at: null,
        created_at: T,
        updated_at: T,
      },
    ],
    [
      'quotation_lines',
      {
        id: 'ql1',
        quote_id: 'q1',
        line_no: 1,
        product_id: 'p1',
        name_snapshot: 'Product',
        sku_snapshot: 'SKU-1',
        qty_milli: 1000,
        unit_price: 1000,
        gross: 1000,
        discount_type: null,
        discount_value: 0,
        discount: 0,
        net: 1000,
        note: '',
        unit_cost_snapshot: 0,
        bundle_id: null,
        bundle_group: null,
        bundle_name: null,
        bundle_qty: null,
        bundle_price: null,
        bundle_component_qty_milli: null,
        bundle_discount: 0,
        created_at: T,
        updated_at: T,
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
}

function validFor(t: TenantFixture, tbl: string): Row {
  const found = validRows(t).find(([name]) => name === tbl);
  if (found === undefined) throw new Error(`no fixture row for ${tbl}`);
  return { tenant_id: t.id, ...found[1] };
}

const EXPECTED_TABLES = [...PLATFORM_TABLES, ...TENANT_TABLES].sort();

async function expectRejected(
  stmt: D1PreparedStatement,
  pattern: RegExp,
): Promise<void> {
  await expect(stmt.run()).rejects.toThrow(pattern);
}

/** Storage persists across tests in one file, so insert both tenants once. */
async function insertTenants(): Promise<void> {
  const n = await db
    .prepare('SELECT COUNT(*) AS n FROM tenants')
    .first<{ n: number }>();
  if ((n?.n ?? 0) > 0) return;
  const stmts: D1PreparedStatement[] = [];
  for (const t of [A, B]) {
    stmts.push(insert('tenants', tenantRow(t)));
    stmts.push(insert('tenant_usage', { tenant_id: t.id, day: DAY }));
    for (const [tbl, row] of validRows(t)) {
      stmts.push(insert(tbl, { tenant_id: t.id, ...row }));
    }
  }
  await db.batch(stmts);
}

async function count(tbl: string, tenantId?: string): Promise<number> {
  const row =
    tenantId === undefined
      ? await db
          .prepare(`SELECT COUNT(*) AS n FROM ${tbl}`)
          .first<{ n: number }>()
      : await db
          .prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE tenant_id = ?1`)
          .bind(tenantId)
          .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('D1 migrations (T-008, multi-tenant)', () => {
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

  it('seeds meta and the 8 expense category templates, and no tenant (02 §2.1)', async () => {
    const meta = await db
      .prepare('SELECT key, value FROM meta ORDER BY key')
      .all<{ key: string; value: string }>();
    expect(
      Object.fromEntries(meta.results.map((r) => [r.key, r.value])),
    ).toEqual({ last_prune_at: '0', prune_cursor: '', schema_version: '10' });
    const cats = await db
      .prepare(
        'SELECT code FROM expense_category_templates ORDER BY sort_order',
      )
      .all<{ code: string }>();
    // No "supplier" category (D-016).
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

  it('starts with no tenant and no tenant rows', async () => {
    // Runs before any insert in this file (tests run in order).
    expect(await count('tenants')).toBe(0);
    expect(await count('expense_categories')).toBe(0);
  });

  it('accepts one valid row per tenant table in two tenants with colliding ids, SKUs, barcodes, prefixes and invoice numbers', async () => {
    await insertTenants();
    for (const tbl of TENANT_TABLES) {
      expect(await count(tbl, A.id), `${tbl} in A`).toBeGreaterThan(0);
      expect(await count(tbl, B.id), `${tbl} in B`).toBe(
        await count(tbl, A.id),
      );
    }
    const skus = await db
      .prepare(
        "SELECT tenant_id FROM products WHERE sku = 'PHO-AB12' ORDER BY tenant_id",
      )
      .all<{ tenant_id: string }>();
    expect(skus.results.map((r) => r.tenant_id)).toEqual([A.id, B.id]);
  });

  describe('per-tenant keys and composite foreign keys', () => {
    beforeAll(insertTenants);

    it('rejects a duplicate primary key, SKU, barcode, bill prefix and invoice number inside one tenant', async () => {
      await expectRejected(
        insert('products', { ...validFor(A, 'products'), sku: 'OTHER-1' }),
        /UNIQUE constraint failed/,
      );
      await expectRejected(
        insert('products', { ...validFor(A, 'products'), id: 'p-dup' }),
        /UNIQUE constraint failed/,
      );
      await expectRejected(
        insert('product_barcodes', {
          ...validFor(B, 'product_barcodes'),
          id: 'pb-dup',
        }),
        /UNIQUE constraint failed/,
      );
      await expectRejected(
        insert('branches', { ...validFor(B, 'branches'), id: 'br-dup' }),
        /UNIQUE constraint failed/,
      );
      await expectRejected(
        insert('sales', {
          ...validFor(A, 'sales'),
          id: 's-dup',
          invoice_seq: 9,
        }),
        /UNIQUE constraint failed/,
      );
      await expectRejected(
        insert('applied_tx', validFor(A, 'applied_tx')),
        /UNIQUE constraint failed/,
      );
    });

    it("rejects a row that references another tenant's row", async () => {
      // 'only-a…' rows exist in A only; B rows pointing at them must fail.
      await insert('customers', {
        ...validFor(A, 'customers'),
        id: 'only-a-customer',
      }).run();
      await insert('sales', {
        ...validFor(A, 'sales'),
        id: 'only-a',
        invoice_no: 'INV-A-77',
        invoice_seq: 77,
      }).run();
      await expectRejected(
        insert('sale_lines', {
          ...validFor(B, 'sale_lines'),
          id: 'sl-x',
          sale_id: 'only-a',
          line_no: 2,
        }),
        /FOREIGN KEY constraint failed/,
      );
      await expectRejected(
        insert('sales', {
          ...validFor(B, 'sales'),
          id: 's-x',
          invoice_no: 'INV-A-78',
          invoice_seq: 78,
          customer_id: 'only-a-customer',
        }),
        /FOREIGN KEY constraint failed/,
      );
      await expectRejected(
        insert('products', {
          ...validFor(B, 'products'),
          tenant_id: 'no-such-tenant',
        }),
        /FOREIGN KEY constraint failed/,
      );
    });

    it("keeps each tenant's rows apart when the ids collide", async () => {
      await db
        .prepare(
          'UPDATE products SET name_en = ?1 WHERE tenant_id = ?2 AND id = ?3',
        )
        .bind('Changed in B', B.id, 'p1')
        .run();
      const a = await db
        .prepare(
          "SELECT name_en FROM products WHERE tenant_id = ?1 AND id = 'p1'",
        )
        .bind(A.id)
        .first<{ name_en: string }>();
      expect(a?.name_en).toBe('Phone X');
    });
  });

  describe('CHECK constraints', () => {
    beforeAll(insertTenants);

    it('rejects a day close whose expected cash does not follow the formula (07 §9)', async () => {
      const base = validFor(A, 'day_closes');
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
      const base = validFor(A, 'sales');
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
      const base = validFor(A, 'refunds');
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

    it('rejects bad tenant, master and ledger rows, enums and STRICT type mismatches', async () => {
      await expectRejected(
        insert('tenants', { ...tenantRow(A), id: 't-bad', slug: 'Bad Slug' }),
        /CHECK constraint failed/,
      );
      await expectRejected(
        insert('tenants', { ...tenantRow(A), id: 't-dup' }),
        /UNIQUE constraint failed/,
      );
      await expectRejected(
        insert('shop', { ...validFor(A, 'shop'), id: 'other' }),
        /CHECK constraint failed/,
      );
      await expectRejected(
        insert('branches', {
          tenant_id: A.id,
          id: 'br2',
          name: 'B',
          bill_prefix: 'inv',
          ...master,
        }),
        /CHECK constraint failed|invalid bill_prefix/,
      );
      await expectRejected(
        insert('branches', {
          tenant_id: A.id,
          id: 'br3',
          name: 'B',
          bill_prefix: 'A-',
          ...master,
        }),
        /invalid bill_prefix/,
      );
      await expectRejected(
        insert('payments', {
          tenant_id: A.id,
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
          tenant_id: A.id,
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
          tenant_id: A.id,
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

    it('applies the D-080–D-084 columns: read-only status, owner email, support devices and codes', async () => {
      await insert('tenants', {
        ...tenantRow(A),
        id: 't-ro',
        slug: 'read-only-shop',
        status: 'read_only',
        status_reason: 'Unpaid invoice',
        status_changed_at: T,
        status_changed_by: 'operator:operator@example.com',
        owner_email: null,
        support_until: T + 3_600_000,
        support_reason: 'Printer setup',
      }).run();
      const ro = await db
        .prepare(
          "SELECT status, owner_email, last_owner_export_at FROM tenants WHERE id = 't-ro'",
        )
        .first<{
          status: string;
          owner_email: string | null;
          last_owner_export_at: number | null;
        }>();
      expect(ro).toEqual({
        status: 'read_only',
        owner_email: null,
        last_owner_export_at: null,
      });
      const badTenants: Row[] = [
        { status: 'paused' },
        { owner_email: 'Owner@Shop.pk' },
        { owner_email: 'no-at-sign' },
        { status_reason: 'x'.repeat(201) },
        { support_reason: 'x'.repeat(201) },
      ];
      for (const bad of badTenants) {
        await expectRejected(
          insert('tenants', {
            ...tenantRow(A),
            id: 't-x',
            slug: 'bad-shop',
            ...bad,
          }),
          /CHECK constraint failed/,
        );
      }

      const device = await db
        .prepare(
          'SELECT kind, expires_at, read_only_seen_at FROM devices WHERE tenant_id = ?1 AND id = ?2',
        )
        .bind(A.id, 'dev1')
        .first();
      expect(device).toEqual({
        kind: 'till',
        expires_at: null,
        read_only_seen_at: null,
      });
      await insert('devices', {
        ...validFor(A, 'devices'),
        id: 'sup1',
        device_code: 'S',
        token_hash: '77'.repeat(32),
        is_admin: 0,
        kind: 'support',
        expires_at: T + 3_600_000,
      }).run();
      await expectRejected(
        insert('devices', {
          ...validFor(A, 'devices'),
          id: 'dev9',
          device_code: 'Z',
          token_hash: '78'.repeat(32),
          kind: 'kiosk',
        }),
        /CHECK constraint failed/,
      );
      await insert('enrolment_codes', {
        ...validFor(A, 'enrolment_codes'),
        code_hash: '79'.repeat(32),
        kind: 'support',
      }).run();
      await expectRejected(
        insert('enrolment_codes', {
          ...validFor(A, 'enrolment_codes'),
          code_hash: '7a'.repeat(32),
          kind: 'other',
        }),
        /CHECK constraint failed/,
      );

      await expectRejected(
        insert('owner_email_codes', {
          ...validFor(A, 'owner_email_codes'),
          id: 'oec2',
          attempts: 6,
        }),
        /CHECK constraint failed/,
      );
      // B's code may not point at a device or owner that only exists in A.
      await expectRejected(
        insert('owner_email_codes', {
          ...validFor(B, 'owner_email_codes'),
          id: 'oec3',
          device_id: 'sup1',
        }),
        /FOREIGN KEY constraint failed/,
      );
    });

    it('enforces unique SKU among non-deleted rows only', async () => {
      const row = {
        tenant_id: B.id,
        name_en: 'Dup',
        sku: 'PHO-AB12',
        price: 1,
        ...master,
      };
      await expectRejected(
        insert('products', { ...row, id: 'p3' }),
        /UNIQUE constraint failed/,
      );
      await db
        .prepare(
          'UPDATE products SET deleted_at = ?1 WHERE tenant_id = ?2 AND id = ?3',
        )
        .bind(T, B.id, 'p1')
        .run();
      await insert('products', { ...row, id: 'p4' }).run();
    });

    it('protects every non-status sales column, including bundle_discount_total (0026)', async () => {
      const trigger = await db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'sales_append_only_update'",
        )
        .first<{ sql: string }>();
      expect(trigger?.sql).toBeTruthy();
      const columns = await db
        .prepare("PRAGMA table_info('sales')")
        .all<{ name: string }>();
      for (const column of columns.results) {
        if (column.name === 'status') continue;
        expect(trigger?.sql, column.name).toContain(column.name);
      }
      await expectRejected(
        db
          .prepare(
            'UPDATE sales SET bundle_discount_total = 1 WHERE tenant_id = ?1 AND id = ?2',
          )
          .bind(A.id, 's1'),
        /sales is append-only/,
      );
    });

    it('rejects a malformed staff verifier and an empty shop time zone (0012)', async () => {
      const staff = {
        tenant_id: A.id,
        name: 'Bad PIN',
        role: 'cashier',
        pin_hash: 'a'.repeat(44),
        pin_salt: 'a'.repeat(24),
        pin_iterations: 150_000,
        ...master,
      };
      await expectRejected(
        insert('staff', { ...staff, id: 'st-bad', pin_iterations: 0 }),
        /pin verifier is malformed/,
      );
      await expectRejected(
        insert('staff', { ...staff, id: 'st-bad2', pin_salt: 'short' }),
        /pin verifier is malformed/,
      );
      await expectRejected(
        insert('shop', {
          tenant_id: A.id,
          id: 'shop-bad',
          name: 'Bad zone',
          business_type: 'mobile',
          phone: '',
          address: '',
          timezone: '',
          ...master,
        }),
        /timezone is malformed/,
      );
    });
  });

  describe('restore-safe bundle and import guards (0032)', () => {
    beforeAll(insertTenants);

    it('restores a soft-deleted recipe row after its component became a bundle (CORE-H1)', async () => {
      await insert('products', {
        tenant_id: A.id,
        id: 'p-h1',
        name_en: 'Former component',
        sku: 'H1-COMP',
        price: 1_000,
        track_stock: 0,
        ...master,
      }).run();
      await db
        .prepare(
          "UPDATE products SET kind = 'bundle', track_stock = 0, updated_at = ?1 WHERE tenant_id = ?2 AND id = 'p-h1'",
        )
        .bind(T + 1, A.id)
        .run();
      // The export replayed by /import still contains the old soft-deleted row.
      await insert('bundle_items', {
        tenant_id: A.id,
        id: 'bi-h1',
        bundle_id: 'p2',
        component_product_id: 'p-h1',
        qty_milli: 1000,
        sort_order: 1,
        deleted_at: T,
        ...master,
      }).run();
      // An active row still cannot nest a bundle.
      await expectRejected(
        insert('bundle_items', {
          tenant_id: A.id,
          id: 'bi-h1-active',
          bundle_id: 'p2',
          component_product_id: 'p-h1',
          qty_milli: 1000,
          sort_order: 2,
          ...master,
        }),
        /a bundle cannot contain another bundle/,
      );
      // A sale rung before the conversion keeps its historical component line.
      await insert('sale_lines', {
        tenant_id: A.id,
        id: 'sl-h1',
        sale_id: 's1',
        line_no: 24,
        product_id: 'p-h1',
        name_snapshot: 'Former component',
        qty_milli: 1000,
        unit_price: 1_000,
        gross: 1_000,
        net: 1_000,
        bundle_id: 'p2',
        bundle_group: 'group-h1',
        bundle_name: 'Starter Pack',
        bundle_qty: 1,
        bundle_price: 1_000,
        bundle_discount: 0,
        bundle_component_qty_milli: 1000,
        created_at: T,
      }).run();
      // A plain sale of the product before it became a bundle restores too.
      await insert('sale_lines', {
        tenant_id: A.id,
        id: 'sl-h1-plain',
        sale_id: 's1',
        line_no: 25,
        product_id: 'p-h1',
        name_snapshot: 'Former component',
        qty_milli: 1000,
        unit_price: 1_000,
        gross: 1_000,
        net: 1_000,
        created_at: T,
      }).run();
      const row = await db
        .prepare(
          'SELECT deleted_at FROM bundle_items WHERE tenant_id = ?1 AND id = ?2',
        )
        .bind(A.id, 'bi-h1')
        .first<{ deleted_at: number }>();
      expect(row?.deleted_at).toBe(T);
    });

    it('converts a zero-movement product with a published catalogue cost to a bundle (CORE-H2)', async () => {
      await insert('products', {
        tenant_id: A.id,
        id: 'p-h2',
        name_en: 'Costed counter item',
        sku: 'H2-COST',
        price: 2_000,
        last_cost: 1_500,
        avg_cost: 1_500,
        cost_changed_at: T,
        track_stock: 0,
        ...master,
      }).run();
      await db
        .prepare(
          "UPDATE products SET kind = 'bundle', track_stock = 0, updated_at = ?1 WHERE tenant_id = ?2 AND id = 'p-h2'",
        )
        .bind(T + 1, A.id)
        .run();
      const row = await db
        .prepare(
          'SELECT kind, track_stock FROM products WHERE tenant_id = ?1 AND id = ?2',
        )
        .bind(A.id, 'p-h2')
        .first<{ kind: string; track_stock: number }>();
      expect(row).toEqual({ kind: 'bundle', track_stock: 0 });
      // A product with real stock history still cannot become a bundle.
      await expectRejected(
        db
          .prepare(
            "UPDATE products SET kind = 'bundle', track_stock = 0 WHERE tenant_id = ?1 AND id = 'p1'",
          )
          .bind(A.id),
        /a bundle cannot have a stock movement/,
      );
    });

    it('rejects a synthetic bundle sale line and partial bundle metadata (CORE-L2)', async () => {
      const line = {
        tenant_id: A.id,
        sale_id: 's1',
        name_snapshot: 'Starter Pack',
        qty_milli: 1000,
        unit_price: 4_500_000,
        gross: 4_500_000,
        net: 4_500_000,
        created_at: T,
      };
      await expectRejected(
        insert('sale_lines', {
          ...line,
          id: 'sl-bundle',
          line_no: 20,
          product_id: 'p2',
        }),
        /a bundle cannot be a sale line/,
      );
      await expectRejected(
        insert('sale_lines', {
          ...line,
          id: 'sl-partial',
          line_no: 21,
          product_id: 'p1',
          bundle_id: 'p2',
        }),
        /bundle sale line metadata must be complete/,
      );
      await expectRejected(
        insert('sale_lines', {
          ...line,
          id: 'sl-discount',
          line_no: 22,
          product_id: 'p1',
          bundle_discount: 1_000,
        }),
        /bundle discount needs a bundle group and price/,
      );
      // A full component line stays valid.
      await insert('sale_lines', {
        ...line,
        id: 'sl-component',
        line_no: 23,
        product_id: 'p1',
        bundle_id: 'p2',
        bundle_group: 'group-h1',
        bundle_name: 'Starter Pack',
        bundle_qty: 1,
        bundle_price: 4_500_000,
        bundle_discount: 0,
        bundle_component_qty_milli: 1000,
      }).run();
    });

    it('rejects self-reversal and reversing a reversal (CORE-L2)', async () => {
      const expense = {
        tenant_id: A.id,
        category_id: 'tea_snacks',
        amount: 20_000,
        ...ledgerCtx,
      };
      await expectRejected(
        insert('expenses', {
          ...expense,
          id: 'ex-self',
          reverses_id: 'ex-self',
        }),
        /an expense cannot reverse itself/,
      );
      await insert('expenses', {
        ...expense,
        id: 'ex-rev1',
        reverses_id: 'ex1',
      }).run();
      await expectRejected(
        insert('expenses', {
          ...expense,
          id: 'ex-rev2',
          reverses_id: 'ex-rev1',
        }),
        /an expense reversal cannot be reversed/,
      );
    });
  });
});
