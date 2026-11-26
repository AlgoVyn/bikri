import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';

// OPS-M1: the data-repair migrations 0013–0031 were only ever executed against an empty
// database in the Worker test harness, so their backfill predicates never saw a row.
// This suite upgrades a populated 0012 schema one migration at a time in node:sqlite
// (the same engine D1 runs) and asserts the rows and change_log entries they produce.

const ROOT = resolve(import.meta.dirname, '..');
const MIGRATIONS = join(ROOT, 'packages/db/migrations');
const FILES = readdirSync(MIGRATIONS)
  .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
  .sort();

const T = 1_793_050_000_000;
const DAY = '2026-10-27';

type Row = Record<string, string | number | null>;

let db: DatabaseSync;
let applied = 0;

function applyThrough(prefix: string): void {
  for (; applied < FILES.length; applied++) {
    const file = FILES[applied];
    if (!file || file.slice(0, 4) > prefix) break;
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
}

function insert(table: string, row: Row): void {
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (tenant_id, ${cols.join(', ')}) VALUES (?1, ${cols
      .map((_, i) => `?${i + 2}`)
      .join(', ')})`,
  ).run('t1', ...Object.values(row));
}

function insertTenant(row: Row): void {
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO tenants (${cols.join(', ')}) VALUES (${cols
      .map((_, i) => `?${i + 1}`)
      .join(', ')})`,
  ).run(...Object.values(row));
}

function product(id: string, name: string, lastCost: number): void {
  insert('products', {
    id,
    name_en: name,
    sku: id,
    price: 5000,
    last_cost: lastCost,
    avg_cost: 0,
    track_stock: 1,
    created_at: T,
    updated_at: T,
  });
}

function movement(
  id: string,
  productId: string,
  qty: number,
  reason: string,
  unitCost: number | null,
  at: number,
): void {
  insert('stock_movements', {
    id,
    product_id: productId,
    qty_delta_milli: qty,
    reason_code: reason,
    ref_type: 'adjustment',
    ref_id: null,
    unit_cost: unitCost,
    branch_id: 'br1',
    device_id: 'dev1',
    staff_id: 'st1',
    business_date: DAY,
    created_at: at,
  });
}

function one<T>(sql: string): T {
  return db.prepare(sql).get() as T;
}

beforeAll(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyThrough('0012');

  insertTenant({
    id: 't1',
    slug: 'backfill-shop',
    display_name: 'Backfill Shop',
    restore_epoch: String(T),
    created_by_email: 'operator@example.com',
    created_at: T,
    updated_at: T,
  });
  insert('shop', {
    id: 'shop',
    name: 'Backfill Shop',
    business_type: 'general',
    phone: '+923001234567',
    address: 'Hall Road, Lahore',
    created_at: T,
    updated_at: T,
  });
  insert('branches', {
    id: 'br1',
    name: 'Main',
    bill_prefix: 'INV',
    is_default: 1,
    created_at: T,
    updated_at: T,
  });
  insert('staff', {
    id: 'st1',
    name: 'Adnan',
    role: 'owner',
    pin_hash: 'a'.repeat(44),
    pin_salt: 'b'.repeat(24),
    created_at: T,
    updated_at: T,
  });
  insert('devices', {
    id: 'dev1',
    name: 'Counter 1',
    branch_id: 'br1',
    device_code: 'A',
    device_code_history: 'A,B',
    token_hash: 'ab'.repeat(32),
    is_admin: 1,
    enrolled_at: T,
    enrolled_by: 'operator:operator@example.com',
    created_at: T,
    updated_at: T,
  });
  product('p1', 'Costed movement', 1500); // has a costed movement
  product('p2', 'No movements', 3000); // no movements: 0024 + 0031 repair it
  product('p3', 'Non-costed count', 1500); // 0030 repairs it
  movement('m1', 'p1', 5000, 'opening', 1500, T - 1000);
  movement('m2', 'p3', 2000, 'count', null, T - 2000);
  insert('sales', {
    id: 's1',
    invoice_no: 'INV-C-9',
    invoice_seq: 9,
    branch_id: 'br1',
    device_id: 'dev1',
    staff_id: 'st1',
    business_date: DAY,
    created_at: T,
    line_count: 1,
    items_qty_milli: 1000,
    gross_total: 5000,
    item_discount_total: 0,
    subtotal: 5000,
    total: 5000,
    paid_total: 5000,
  });
  insert('sale_lines', {
    id: 'sl1',
    sale_id: 's1',
    line_no: 1,
    product_id: 'p1',
    name_snapshot: 'Phone X',
    qty_milli: 1000,
    unit_price: 5000,
    gross: 5000,
    net: 5000,
    created_at: T,
  });
});

describe('incremental migration backfills (OPS-M1)', () => {
  it('0013 fills the stock cache on a populated table', () => {
    applyThrough('0013');
    const p1 = one<{ on_hand_milli: number; cost_changed_at: number }>(
      "SELECT on_hand_milli, cost_changed_at FROM products WHERE id = 'p1'",
    );
    expect(p1.on_hand_milli).toBe(5000);
    expect(p1.cost_changed_at).toBe(T - 1000);
    const p2 = one<{ on_hand_milli: number; cost_changed_at: number }>(
      "SELECT on_hand_milli, cost_changed_at FROM products WHERE id = 'p2'",
    );
    expect(p2).toEqual({ on_hand_milli: 0, cost_changed_at: 0 });
  });

  it('0015 copies the sale business date onto every line', () => {
    applyThrough('0015');
    expect(
      one<{ business_date: string }>(
        "SELECT business_date FROM sale_lines WHERE id = 'sl1'",
      ).business_date,
    ).toBe(DAY);
  });

  it('0024 copies the catalogue cost only for products with no movement', () => {
    applyThrough('0024');
    expect(
      one<{ avg_cost: number }>("SELECT avg_cost FROM products WHERE id = 'p2'")
        .avg_cost,
    ).toBe(3000);
    expect(
      one<{ avg_cost: number }>("SELECT avg_cost FROM products WHERE id = 'p3'")
        .avg_cost,
    ).toBe(0);
  });

  it('0028 backfills device codes from devices, history and invoice numbers', () => {
    applyThrough('0028');
    const codes = db
      .prepare(
        "SELECT device_code FROM branch_device_codes WHERE tenant_id = 't1' ORDER BY device_code",
      )
      .all()
      .map((row) => String(row.device_code));
    expect(codes).toEqual(['A', 'B', 'C']);
  });

  it('0030 repairs a zero-average product with only a non-costed movement', () => {
    applyThrough('0030');
    const p3 = one<{
      avg_cost: number;
      rev: number;
      cost_changed_at: number;
    }>("SELECT avg_cost, rev, cost_changed_at FROM products WHERE id = 'p3'");
    expect(p3.avg_cost).toBe(1500);
    expect(p3.rev).toBe(2);
    expect(p3.cost_changed_at).toBeGreaterThan(0);
    const logged = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM change_log WHERE tenant_id = 't1' AND tbl = 'products' AND row_id = 'p3'",
    );
    expect(logged.n).toBe(1);
  });

  it('0031 repairs zero-movement product costs and publishes them', () => {
    applyThrough('0031');
    const p2 = one<{
      avg_cost: number;
      rev: number;
      cost_changed_at: number;
    }>("SELECT avg_cost, rev, cost_changed_at FROM products WHERE id = 'p2'");
    expect(p2.avg_cost).toBe(3000);
    expect(p2.rev).toBe(2);
    expect(p2.cost_changed_at).toBeGreaterThan(0);
    const log = one<{ row_json: string }>(
      "SELECT row_json FROM change_log WHERE tenant_id = 't1' AND tbl = 'products' AND row_id = 'p2'",
    );
    expect(JSON.parse(log.row_json)).toMatchObject({
      id: 'p2',
      avg_cost: 3000,
      rev: 2,
      kind: 'simple',
    });
  });

  it('applies 0032-0035 on the populated schema', () => {
    applyThrough('0035');
    expect(
      one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM pragma_table_info('products') WHERE name = 'bundle_since'",
      ).n,
    ).toBe(1);
  });

  it('restores a converted bundle with its historical simple-product sale line', () => {
    // A backup does not carry `bundle_since`; the insert trigger must use the
    // product's last edit (the conversion point), not its original creation time.
    insert('products', {
      id: 'p-restored-bundle',
      name_en: 'Converted product',
      sku: 'RESTORE-BUNDLE',
      kind: 'bundle',
      track_stock: 0,
      price: 100,
      last_cost: 0,
      avg_cost: 0,
      created_at: 100,
      updated_at: 200,
      rev: 1,
    });
    insert('sales', {
      id: 's-restored',
      invoice_no: 'RESTORE-1',
      invoice_seq: 999,
      branch_id: 'br1',
      device_id: 'dev1',
      staff_id: 'st1',
      business_date: DAY,
      created_at: 150,
      line_count: 1,
      items_qty_milli: 1000,
      gross_total: 100,
      item_discount_total: 0,
      subtotal: 100,
      bill_discount: 0,
      tax_rate_bp: 0,
      tax: 0,
      rounding: 0,
      total: 100,
      paid_total: 100,
      udhaar_amount: 0,
      cash_tendered: 100,
      change_given: 0,
      status: 'paid',
      note: '',
    });
    expect(() =>
      insert('sale_lines', {
        id: 'sl-restored',
        sale_id: 's-restored',
        line_no: 1,
        product_id: 'p-restored-bundle',
        name_snapshot: 'Converted product',
        sku_snapshot: 'RESTORE-BUNDLE',
        qty_milli: 1000,
        unit_price: 100,
        gross: 100,
        discount_value: 0,
        discount: 0,
        net: 100,
        bill_discount_alloc: 0,
        tax_alloc: 0,
        rounding_alloc: 0,
        unit_cost_snapshot: 0,
        below_cost: 0,
        created_at: 150,
      }),
    ).not.toThrow();
  });

  it('applies every migration through 0038 and records schema 10', () => {
    applyThrough('9999');
    expect(applied).toBe(FILES.length);
    expect(
      one<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      ).value,
    ).toBe('10');
    expect(
      one<{ last_quote_seq: number }>(
        "SELECT last_quote_seq FROM devices WHERE id = 'dev1'",
      ).last_quote_seq,
    ).toBe(0);

    const dropped = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
          'quotation_lines_quote', 'quotation_lines_product', 'quotations_date',
          'quotations_validity', 'quotations_customer', 'quotations_sale'
        ) ORDER BY name`,
      )
      .all();
    expect(dropped).toEqual([]);
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'quotation%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    expect(triggers).toContain('quotations_round_total_to_insert');
    expect(triggers).toContain(
      'quotation_lines_bundle_metadata_complete_insert',
    );
    expect(triggers).toContain('quotation_lines_no_bundle_product_insert');
  });

  it('leaves a costed product on hand and the database consistent', () => {
    const p1 = one<{ on_hand_milli: number }>(
      "SELECT on_hand_milli FROM products WHERE id = 'p1'",
    );
    expect(p1.on_hand_milli).toBe(5000);
    expect(one<{ integrity_check: string }>('PRAGMA integrity_check')).toEqual({
      integrity_check: 'ok',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
