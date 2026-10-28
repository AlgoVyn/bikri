#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
/**
 * T-062 measurement: build a scratch SQLite DB from the real migrations, put
 * 1,000 products / 500 customers in two shops, add 20,000 bills over 120 days
 * per shop, and report page-size growth per bill and per shop-year.
 *
 *   node tools/perf/measure-d1.mjs [--bills 20000] [--days 120]
 *
 * Uses Node's built-in `node:sqlite`; it never touches D1.
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.UTC(2026, 9, 28, 12, 0);
const DAY = 86_400_000;

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 1) throw new Error(`bad --${key}`);
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

export function bytes(db) {
  const page = db.prepare('PRAGMA page_size').get();
  const count = db.prepare('PRAGMA page_count').get();
  return Number(page.page_size) * Number(count.page_count);
}

export function isoDate(at) {
  return new Date(at).toISOString().slice(0, 10);
}

export function productRow(tenant, index, now) {
  return {
    id: `p-${tenant}-${index}`,
    name_en: `Product ${index}`,
    name_ur: '',
    brand: 'Perf',
    category_id: null,
    sku: `SKU-${tenant}-${index}`,
    unit: 'pc',
    price: 100_000 + (index % 50) * 1_000,
    last_cost: 80_000,
    avg_cost: 80_000,
    min_stock_milli: 0,
    track_stock: 1,
    tax_rate_bp: null,
    track_serial: 0,
    warranty_days: 0,
    pack_size_milli: null,
    image_key: null,
    notes: '',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    rev: 1,
    updated_by: null,
  };
}

export function customerRow(tenant, index, now) {
  return {
    id: `c-${tenant}-${index}`,
    name: `Customer ${index}`,
    phone: `+92300${String(index).padStart(7, '0')}`,
    address: '',
    note: '',
    credit_limit: null,
    hard_limit: 0,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    rev: 1,
    updated_by: null,
  };
}

export function saleRows(tenant, bill, products, customer, day) {
  const saleId = `s-${tenant}-${bill}`;
  const unit = 100_000 + (bill % 50) * 1_000;
  const total = 3 * unit;
  const paid = Math.floor(total / 2);
  const udhaar = total - paid;
  const sale = {
    id: saleId,
    invoice_no: `INV-${tenant}-${bill}`,
    invoice_seq: bill,
    branch_id: `b-${tenant}`,
    device_id: `d-${tenant}`,
    staff_id: `st-${tenant}`,
    customer_id: customer,
    business_date: isoDate(day),
    created_at: day,
    line_count: 3,
    items_qty_milli: 3000,
    gross_total: total,
    item_discount_total: 0,
    subtotal: total,
    bill_discount_type: null,
    bill_discount_value: 0,
    bill_discount: 0,
    tax_rate_bp: 0,
    tax: 0,
    tax_inclusive: 0,
    rounding: 0,
    total,
    paid_total: paid,
    udhaar_amount: udhaar,
    cash_tendered: paid,
    change_given: 0,
    status: 'paid',
    replaces_sale_id: null,
    note: '',
  };
  const lines = [0, 1, 2].map((n) => ({
    id: `l-${tenant}-${bill}-${n}`,
    sale_id: saleId,
    line_no: n + 1,
    product_id: products[(bill * 3 + n) % products.length],
    name_snapshot: `Product ${(bill * 3 + n) % products.length}`,
    sku_snapshot: `SKU-${tenant}-${(bill * 3 + n) % products.length}`,
    qty_milli: 1000,
    unit_price: unit,
    gross: unit,
    discount_type: null,
    discount_value: 0,
    discount: 0,
    net: unit,
    bill_discount_alloc: 0,
    tax_alloc: 0,
    rounding_alloc: 0,
    unit_cost_snapshot: 80_000,
    below_cost: 0,
    serial: null,
    warranty_until: null,
    created_at: day,
  }));
  const payment = {
    id: `pay-${tenant}-${bill}`,
    direction: 'in',
    method: 'cash',
    purpose: 'sale',
    amount: paid,
    cash_tendered: paid,
    change_given: 0,
    reference: '',
    sale_id: saleId,
    refund_id: null,
    purchase_id: null,
    supplier_return_id: null,
    party_type: null,
    party_id: null,
    note: '',
    branch_id: `b-${tenant}`,
    device_id: `d-${tenant}`,
    staff_id: `st-${tenant}`,
    business_date: isoDate(day),
    created_at: day,
  };
  const ledger = {
    id: `le-${tenant}-${bill}`,
    party_type: 'customer',
    party_id: customer,
    amount: udhaar,
    source_type: 'sale',
    source_id: saleId,
    note: '',
    branch_id: `b-${tenant}`,
    device_id: `d-${tenant}`,
    staff_id: `st-${tenant}`,
    business_date: isoDate(day),
    created_at: day,
  };
  const movements = lines.map((line, n) => ({
    id: `sm-${tenant}-${bill}-${n}`,
    product_id: line.product_id,
    qty_delta_milli: -1000,
    reason_code: 'sale',
    ref_type: 'sale',
    ref_id: saleId,
    unit_cost: null,
    note: '',
    branch_id: `b-${tenant}`,
    device_id: `d-${tenant}`,
    staff_id: `st-${tenant}`,
    business_date: isoDate(day),
    created_at: day,
  }));
  return { sale, lines, payment, ledger, movements };
}

export function insert(db, table, row) {
  const fields = Object.keys(row);
  const sql = `INSERT INTO "${table}" (${fields.map((f) => `"${f}"`).join(',')}) VALUES (${fields.map(() => '?').join(',')})`;
  db.prepare(sql).run(...fields.map((field) => row[field]));
}

function writeBill(db, tenant, bill, products, customer, day) {
  const { sale, lines, payment, ledger, movements } = saleRows(
    tenant,
    bill,
    products,
    customer,
    day,
  );
  insert(db, 'sales', { tenant_id: tenant, ...sale });
  for (const line of lines)
    insert(db, 'sale_lines', { tenant_id: tenant, ...line });
  insert(db, 'payments', { tenant_id: tenant, ...payment });
  insert(db, 'ledger_entries', { tenant_id: tenant, ...ledger });
  for (const movement of movements)
    insert(db, 'stock_movements', { tenant_id: tenant, ...movement });
  const all = [
    ['sales', sale],
    ...lines.map((line) => ['sale_lines', line]),
    ['payments', payment],
    ['ledger_entries', ledger],
    ...movements.map((movement) => ['stock_movements', movement]),
  ];
  for (const [table, row] of all) {
    db.prepare(
      'INSERT INTO change_log (tenant_id, tbl, row_id, op, row_json, device_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      tenant,
      table,
      row.id,
      'upsert',
      JSON.stringify(row),
      `d-${tenant}`,
      day,
    );
    db.prepare(
      'INSERT INTO applied_ops (tenant_id, op_id, device_id, applied_at, result, error_code) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run(
      tenant,
      `op-${tenant}-${bill}-${table}-${row.id}`,
      `d-${tenant}`,
      day,
      'applied',
    );
  }
}

export function measure({ bills = 20_000, days = 120 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bikri-perf-'));
  const file = join(dir, 'perf.sqlite');
  const db = new DatabaseSync(file);
  try {
    for (const name of [
      '0001_init.sql',
      '0002_seed.sql',
      '0003_perf_indexes.sql',
    ])
      db.exec(readFileSync(join(ROOT, 'packages/db/migrations', name), 'utf8'));
    // Sizing only: no need to materialise every parent row.
    db.exec('PRAGMA foreign_keys = OFF');
    const tenants = ['perf-a', 'perf-b'];
    const products = [];
    const customers = [];
    for (const tenant of tenants) {
      db.prepare(
        'INSERT INTO tenants (id, slug, display_name, restore_epoch, created_by_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(tenant, tenant, tenant, String(NOW), 'operator@test', NOW, NOW);
      for (let i = 0; i < 1000; i += 1) {
        const row = productRow(tenant, i, NOW);
        products.push(row.id);
        insert(db, 'products', { tenant_id: tenant, ...row });
      }
      for (let i = 0; i < 500; i += 1) {
        const row = customerRow(tenant, i, NOW);
        customers.push(row.id);
        insert(db, 'customers', { tenant_id: tenant, ...row });
      }
    }
    const baseline = bytes(db);
    db.exec('BEGIN');
    for (const tenant of tenants) {
      const mine = products.filter((id) => id.startsWith(`p-${tenant}-`));
      const myCustomers = customers.filter((id) =>
        id.startsWith(`c-${tenant}-`),
      );
      for (let bill = 1; bill <= bills; bill += 1) {
        const day = NOW - (bill % days) * DAY;
        writeBill(
          db,
          tenant,
          bill,
          mine,
          myCustomers[bill % myCustomers.length],
          day,
        );
      }
    }
    db.exec('COMMIT');
    // Same retention as the nightly prune: change_log 30 days, applied_ops 90.
    db.prepare('DELETE FROM change_log WHERE at < ?').run(NOW - 30 * DAY);
    db.prepare('DELETE FROM applied_ops WHERE applied_at < ?').run(
      NOW - 90 * DAY,
    );
    db.exec('VACUUM');
    const final = bytes(db);
    const delta = final - baseline;
    return {
      billsPerShop: bills,
      days,
      tenants: tenants.length,
      baselineBytes: baseline,
      finalBytes: final,
      bytesPerBill: Math.round(delta / (bills * tenants.length)),
      bytesPerShopYear: Math.round(
        (delta / tenants.length) * (365 / days) + baseline / tenants.length,
      ),
      bytesPerShopDay: Math.round(
        ((delta / tenants.length) * (365 / days) + baseline / tenants.length) /
          365,
      ),
      rowsPerBill: 27,
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(measure(args), null, 2));
}
