#!/usr/bin/env node
/**
 * A large, realistic shop in the **local** D1 so performance work measures the real app.
 *
 *   node tools/seed/perf-shop.mjs [options]
 *
 * The rows are written straight into the local `wrangler dev` SQLite file (never D1 in
 * production). A fresh till then enrols with the printed code and downloads the shop
 * through the ordinary snapshot API, so the download, cache rebuild and every screen
 * afterwards are exercised exactly as in production.
 *
 * Options (defaults in brackets):
 *   --tenant <slug>      tenant slug; re-running replaces that shop   [perf-shop]
 *   --bills <n>          bills over the period                        [25000]
 *   --days <n>           days of history, today included              [180]
 *   --products <n>       simple products                              [2000]
 *   --customers <n>      customers                                    [1000]
 *   --suppliers <n>      suppliers                                    [60]
 *   --purchases <n>      supplier deliveries                          [700]
 *   --expenses <n>       expenses                                     [800]
 *   --closes <n>         day closes (last n days, today excluded)     [60]
 *   --code <CODE>        fixed enrolment code                         [PRFM-2K9X]
 *   --pin <digits>       owner PIN                                    [4826]
 *   --seed <text>        PRNG seed; same seed = same shop              [bikri-perf]
 *   --db <path>          local D1 SQLite file (auto-detected by default)
 *   --help
 */
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const D1_DIR = join(
  ROOT,
  'apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
);
const DAY = 86_400_000;
const KARACHI_OFFSET = 5 * 3_600_000;
/** Must match the `--var OWNER_CODE_KEY` used to start `wrangler dev`. */
export const OWNER_CODE_KEY = 'bikri-local-owner-code-key';
export const OWNER_SESSION_KEY = 'bikri-local-owner-session-key';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ---------------------------------------------------------------------------
// arguments

function usage() {
  console.log(
    'Usage: node tools/seed/perf-shop.mjs [--bills 25000] [--days 180] [--help]',
  );
}

function parseArgs(argv) {
  const out = {
    tenant: 'perf-shop',
    bills: 25_000,
    days: 180,
    products: 2_000,
    customers: 1_000,
    suppliers: 60,
    purchases: 700,
    expenses: 800,
    closes: 60,
    code: 'PRFM-2K9X',
    pin: '4826',
    seed: 'bikri-perf',
    db: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    i += 1;
    if (key === 'db') {
      out.db = value;
      continue;
    }
    if (!(key in out)) throw new Error(`unknown option --${key}`);
    if (typeof out[key] === 'number') {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error(`--${key} must be a positive integer`);
      out[key] = number;
    } else {
      out[key] = value;
    }
  }
  if (out.bills < out.days)
    throw new Error('--bills must be at least --days (one bill per day)');
  if (out.products < 12) throw new Error('--products must be at least 12');
  if (out.customers < 20) throw new Error('--customers must be at least 20');
  if (out.suppliers < 3) throw new Error('--suppliers must be at least 3');
  if (!/^[2-9A-HJKMNP-TV-Z]{4}-?[2-9A-HJKMNP-TV-Z]{4}$/i.test(out.code))
    throw new Error('--code must look like ABCD-EFGH (no 0 O 1 I L U)');
  if (!/^\d{4,6}$/.test(out.pin)) throw new Error('--pin must be 4-6 digits');
  return out;
}

// ---------------------------------------------------------------------------
// deterministic randomness and ids

/** 32-bit FNV-1a so a text seed maps to a stable PRNG seed. */
function hashSeed(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function rng(text) {
  let state = hashSeed(text);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function between(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

/** 10-char Crockford Base32 time part of a ULID. */
function encodeTime(ms) {
  let left = ms;
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[left % 32] + out;
    left = Math.floor(left / 32);
  }
  return out;
}

/** Deterministic ULID-shaped id: time part from `at`, random part from `key`. */
function idAt(at, key) {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  let random = '';
  for (const char of digest) random += CROCKFORD[Number.parseInt(char, 16)];
  return encodeTime(at) + random;
}

/** Largest-remainder split of `amount` over `weights` (paisa). */
function allocate(amount, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (amount === 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (amount * weight) / total);
  const out = exact.map((value) => Math.floor(value));
  let left = amount - out.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  let cursor = 0;
  while (left > 0) {
    out[order[cursor % order.length].index] += 1;
    left -= 1;
    cursor += 1;
  }
  return out;
}

function roundTo(amount, step) {
  return Math.round(amount / step) * step;
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD in the shop time zone. */
function businessDateOf(ms) {
  const parts = dateFormatter.formatToParts(new Date(ms));
  const value = (type) =>
    parts.find((part) => part.type === type)?.value ?? '01';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

// ---------------------------------------------------------------------------
// schema helpers

function findLocalD1() {
  if (!existsSync(D1_DIR))
    throw new Error(
      `no local D1 at ${D1_DIR}; run \`pnpm --filter @bikri/api db:migrate:local\` first`,
    );
  const files = readdirSync(D1_DIR)
    .filter((file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite')
    .map((file) => join(D1_DIR, file))
    .filter((file) => statSync(file).size > 0);
  if (files.length === 1) return files[0];
  if (files.length === 0)
    throw new Error(
      `no local D1 database in ${D1_DIR}; run \`pnpm --filter @bikri/api db:migrate:local\` first`,
    );
  throw new Error(
    `more than one local D1 database; pass --db <file>\n${files.join('\n')}`,
  );
}

function assertSchema(db) {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  for (const table of ['tenants', 'shop', 'sales', 'products', 'change_log']) {
    if (!tables.has(table))
      throw new Error(
        `the local D1 has no ${table} table; run \`pnpm --filter @bikri/api db:migrate:local\` first`,
      );
  }
}

function rowWriter(db) {
  const cache = new Map();
  return (table, row) => {
    const columns = Object.keys(row);
    const key = `${table}\u0000${columns.join(',')}`;
    let statement = cache.get(key);
    if (!statement) {
      statement = db.prepare(
        `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      );
      cache.set(key, statement);
    }
    const values = columns.map((column) => {
      const value = row[column];
      if (value === undefined)
        throw new Error(`missing value for ${table}.${column}`);
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new Error(`non-finite value for ${table}.${column}`);
      return value;
    });
    statement.run(...values);
  };
}

const TENANT_TABLES = [
  'shop',
  'branches',
  'devices',
  'staff',
  'categories',
  'products',
  'bundle_items',
  'product_barcodes',
  'customers',
  'suppliers',
  'expense_categories',
  'promises',
  'sales',
  'sale_lines',
  'refunds',
  'refund_lines',
  'sale_voids',
  'purchases',
  'purchase_lines',
  'supplier_returns',
  'supplier_return_lines',
  'payments',
  'ledger_entries',
  'stock_movements',
  'expenses',
  'cash_moves',
  'day_closes',
  'audit_log',
  'sync_conflicts',
  'change_log',
  'change_log_watermarks',
  'applied_ops',
  'branch_device_codes',
  'owner_email_codes',
  'tenant_usage',
];

function wipeTenant(db, id) {
  const existing = db
    .prepare('SELECT 1 AS found FROM tenants WHERE id = ?1')
    .get(id);
  if (!existing) return;
  // The append-only delete triggers allow removal while the operator is deleting a
  // shop (13 §7.4); this is the local equivalent of that teardown.
  db.prepare(
    "UPDATE tenants SET status = 'deleting', updated_at = ?2 WHERE id = ?1",
  ).run(id, Date.now());
  for (const table of TENANT_TABLES)
    db.prepare(`DELETE FROM "${table}" WHERE tenant_id = ?1`).run(id);
  db.prepare('DELETE FROM enrolment_codes WHERE tenant_id = ?1').run(id);
  db.prepare('DELETE FROM tenants WHERE id = ?1').run(id);
}

function countByTenant(db, id) {
  const out = {};
  for (const table of TENANT_TABLES) {
    if (table === 'change_log' || table === 'applied_ops') continue;
    out[table] = Number(
      db
        .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE tenant_id = ?1`)
        .get(id).n,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// the shop

const EXPENSE_CATEGORIES = [
  ['electricity', 'Electricity', 'بجلی', 'bolt', 1],
  ['tea_snacks', 'Tea & snacks', 'چائے پانی', 'cup', 2],
  ['transport', 'Transport', 'کرایہ', 'truck', 3],
  ['salary', 'Salary', 'تنخواہ', 'users', 4],
  ['rent', 'Rent', 'کرایہ دکان', 'home', 5],
  ['repairs', 'Repairs', 'مرمت', 'wrench', 6],
  ['internet_phone', 'Internet & phone', 'انٹرنیٹ و فون', 'wifi', 7],
  ['other', 'Other', 'دیگر', 'dots', 99],
];

const CATEGORIES = [
  ['Smartphones', 'اسمارٹ فون', 't1'],
  ['Chargers', 'چارجر', 't2'],
  ['Cables', 'کیبل', 't3'],
  ['Earbuds', 'ایئربڈز', 't4'],
  ['Power banks', 'پاور بینک', 't5'],
  ['Covers', 'کور', 't6'],
  ['Screen protectors', 'اسکرین گارڈ', 't7'],
  ['Memory cards', 'میموری کارڈ', 't8'],
  ['Speakers', 'اسپیکر', 't1'],
  ['Smart watches', 'اسمارٹ واچ', 't2'],
  ['Accessories', 'لوازمات', 't3'],
  ['Repair services', 'مرمت سروس', 't4'],
];

const BRANDS = [
  'Samsung',
  'Infinix',
  'Tecno',
  'Oppo',
  'Vivo',
  'Nokia',
  'Xiaomi',
  'Realme',
  'Itel',
  'Apple',
  'Anker',
  'Baseus',
];
const MODELS = [
  'Galaxy',
  'Hot',
  'Spark',
  'Reno',
  'Y',
  'G',
  'Redmi',
  'C',
  'Note',
  'Prime',
  'PowerCore',
  'Air',
];
const VARIANTS = [
  'A15 128GB',
  'A05 64GB',
  'Hot 40 128GB',
  'Spark 20C',
  'Reno 11F',
  'Y17s',
  'G24',
  'Note 13',
  'C55',
  'Prime 5',
  '25W fast charger',
  '1 m USB-C cable',
  '10000 mAh power bank',
  'wireless earbuds',
  'clear cover',
  'tempered glass',
  '64 GB memory card',
  'Bluetooth speaker',
  'smart watch strap',
  'car mount',
  'SIM ejector pin',
  'screen repair labour',
];

const FIRST_NAMES = [
  'Bilal',
  'Hamza',
  'Ali',
  'Ayesha',
  'Sana',
  'Usman',
  'Fatima',
  'Zain',
  'Hira',
  'Imran',
  'Kashif',
  'Mariam',
  'Naveed',
  'Rabia',
  'Saad',
  'Tariq',
  'Waseem',
  'Yasmin',
  'Adnan',
  'Nadia',
  'Faisal',
  'Adeel',
  'Rizwan',
  'Shazia',
];
const LAST_NAMES = [
  'Ahmed',
  'Khan',
  'Malik',
  'Sheikh',
  'Butt',
  'Chaudhry',
  'Qureshi',
  'Raza',
  'Siddiqui',
  'Akhtar',
  'Bhatti',
  'Gill',
  'Hussain',
  'Iqbal',
  'Javed',
  'Mirza',
];
const SUPPLIER_NAMES = [
  'Hall Road Traders',
  'Mobile Zone Wholesale',
  'Al-Fateh Electronics',
  'Pak Mobile House',
  'Zeeshan Traders',
  'New Star Distributors',
  'Lahore Accessories Co.',
  'Gulberg Imports',
  'Shalimar Mobile Mart',
  'Al-Madina Traders',
];
const EXPENSE_PAYEES = [
  '',
  'LESCO',
  'Shop landlord',
  'Careem',
  'Tea stall',
  'PTCL',
  'Repair workshop',
];

function pinVerifier(pin, key) {
  const salt = createHash('sha256')
    .update(`salt:${key}`)
    .digest()
    .subarray(0, 16);
  const hash = pbkdf2Sync(pin, salt, 150_000, 32, 'sha256');
  return {
    pin_hash: hash.toString('base64'),
    pin_salt: salt.toString('base64'),
    pin_iterations: 150_000,
    pin_length: pin.length,
  };
}

function buildContext(options, now) {
  const random = rng(options.seed);
  const tenantId = null; // filled in main
  const branchId = idAt(now - options.days * DAY, 'branch');
  const deviceId = idAt(now - options.days * DAY, 'device');
  const ownerId = idAt(now - options.days * DAY, 'staff:owner');
  const managerId = idAt(now - options.days * DAY, 'staff:manager');
  const cashierIds = [
    idAt(now - options.days * DAY, 'staff:cashier:1'),
    idAt(now - options.days * DAY, 'staff:cashier:2'),
  ];
  const categories = CATEGORIES.map(([nameEn, nameUr, color], index) => ({
    id: idAt(now - options.days * DAY, `category:${index}`),
    name_en: nameEn,
    name_ur: nameUr,
    color,
    sort_order: index + 1,
  }));
  const products = [];
  for (let i = 0; i < options.products; i += 1) {
    const category = categories[i % categories.length];
    const price = between(random, 5_000, 5_000_000);
    const cost = Math.round((price * between(random, 68, 92)) / 100);
    const warrantyDays = pick(random, [0, 0, 0, 90, 365]);
    products.push({
      id: idAt(now - options.days * DAY, `product:${i}`),
      name_en:
        `${pick(random, BRANDS)} ${pick(random, MODELS)} ${pick(random, VARIANTS)}`.slice(
          0,
          80,
        ),
      name_ur: '',
      brand: '',
      category_id: category.id,
      sku: `SKU-${String(i + 1).padStart(5, '0')}`,
      unit: 'pc',
      price,
      last_cost: cost,
      avg_cost: cost,
      min_stock_milli: pick(random, [0, 0, 0, 5_000]),
      track_stock: i % 37 === 0 ? 0 : 1,
      tax_rate_bp: null,
      track_serial: 0,
      warranty_days: warrantyDays,
      pack_size_milli: null,
      image_key: null,
      notes: '',
      on_hand_milli: 0,
      cost_changed_at: 0,
      created_at: now - options.days * DAY,
      updated_at: now - options.days * DAY,
      deleted_at: null,
      rev: 1,
      updated_by: null,
      kind: 'simple',
    });
  }
  // A dozen fixed-recipe bundles from the first tracked products (v1.1).
  const bundles = [];
  const bundleItems = [];
  for (let i = 0; i < 12; i += 1) {
    const components = [products[i * 3], products[i * 3 + 1]].filter(
      (product) => product && product.track_stock === 1,
    );
    if (components.length < 2) continue;
    const componentCost = components.reduce(
      (sum, product) => sum + product.avg_cost,
      0,
    );
    const id = idAt(now - options.days * DAY, `bundle:${i}`);
    bundles.push({
      id,
      name_en: `Starter Pack ${i + 1}`.slice(0, 80),
      name_ur: '',
      brand: '',
      category_id: components[0].category_id,
      sku: `BND-${String(i + 1).padStart(3, '0')}`,
      unit: 'set',
      price: Math.round(componentCost * 1.12),
      last_cost: componentCost,
      avg_cost: 0,
      min_stock_milli: 0,
      track_stock: 0,
      tax_rate_bp: null,
      track_serial: 0,
      warranty_days: 0,
      pack_size_milli: null,
      image_key: null,
      notes: '',
      on_hand_milli: 0,
      cost_changed_at: 0,
      created_at: now - options.days * DAY,
      updated_at: now - options.days * DAY,
      deleted_at: null,
      rev: 1,
      updated_by: null,
      kind: 'bundle',
    });
    components.forEach((component, index) => {
      bundleItems.push({
        id: idAt(now - options.days * DAY, `bundle-item:${i}:${index}`),
        bundle_id: id,
        component_product_id: component.id,
        qty_milli: 1000,
        sort_order: index,
        created_at: now - options.days * DAY,
        updated_at: now - options.days * DAY,
        deleted_at: null,
        rev: 1,
        updated_by: null,
      });
    });
  }
  const customers = [];
  for (let i = 0; i < options.customers; i += 1) {
    const limit = i % 5 === 0 ? between(random, 50_000, 500_000) * 10 : null;
    customers.push({
      id: idAt(now - options.days * DAY, `customer:${i}`),
      name: `${pick(random, FIRST_NAMES)} ${pick(random, LAST_NAMES)}`,
      phone: `+923${String(10_000_000 + i).padStart(9, '0')}`,
      address: '',
      note: '',
      credit_limit: limit,
      hard_limit: limit !== null && i % 17 === 0 ? 1 : 0,
      created_at: now - options.days * DAY,
      updated_at: now - options.days * DAY,
      deleted_at: null,
      rev: 1,
      updated_by: null,
    });
  }
  const suppliers = [];
  for (let i = 0; i < options.suppliers; i += 1) {
    suppliers.push({
      id: idAt(now - options.days * DAY, `supplier:${i}`),
      name: `${SUPPLIER_NAMES[i % SUPPLIER_NAMES.length]} ${Math.floor(i / SUPPLIER_NAMES.length) + 1}`,
      phone: `+924${String(20_000_000 + i).padStart(9, '0')}`,
      address: '',
      note: '',
      created_at: now - options.days * DAY,
      updated_at: now - options.days * DAY,
      deleted_at: null,
      rev: 1,
      updated_by: null,
    });
  }
  return {
    ...options,
    now,
    tenantId,
    branchId,
    deviceId,
    ownerId,
    managerId,
    cashierIds,
    staffIds: [ownerId, managerId, ...cashierIds],
    categories,
    products,
    bundles,
    bundleItems,
    customers,
    suppliers,
  };
}

/** Day timestamps: index 0 is today, index `days-1` the oldest. */
function makeDays(ctx) {
  const today = businessDateOf(ctx.now);
  const [year, month, day] = today.split('-').map(Number);
  const days = [];
  for (let i = 0; i < ctx.days; i += 1) {
    const calendar = Date.UTC(year, month - 1, day) - i * DAY;
    const parts = new Date(calendar);
    const date = `${parts.getUTCFullYear()}-${String(parts.getUTCMonth() + 1).padStart(2, '0')}-${String(parts.getUTCDate()).padStart(2, '0')}`;
    const start = calendar - KARACHI_OFFSET;
    days.push({ index: i, date, start, end: start + DAY - 1 });
  }
  return days;
}

function saleTimestamp(ctx, days, dayIndex, random) {
  const day = days[dayIndex];
  const from = day.start + 9 * 3_600_000;
  const to = day.start + 21 * 3_600_000;
  const latest = Math.min(to, ctx.now - 60_000);
  if (latest <= from) return Math.max(day.start + 1, latest);
  return from + Math.floor(random() * (latest - from));
}

/**
 * Every bill, deterministic for a given seed. Generating twice lets the first pass size
 * the opening stock without keeping 25,000 bills in memory.
 */
function* billStream(ctx, days) {
  const random = rng(`${ctx.seed}:bills`);
  const staffShare = [
    ctx.ownerId,
    ctx.managerId,
    ctx.ownerId,
    ctx.cashierIds[0],
    ctx.cashierIds[0],
    ctx.cashierIds[0],
    ctx.cashierIds[1],
    ctx.cashierIds[1],
    ctx.managerId,
    ctx.cashierIds[0],
  ];
  for (let bill = 1; bill <= ctx.bills; bill += 1) {
    const dayIndex = (bill - 1) % ctx.days;
    const at = saleTimestamp(ctx, days, dayIndex, random);
    const date = days[dayIndex].date;
    const lineCount = pick(random, [1, 1, 1, 2, 2, 3, 3, 4]);
    const chosen = new Set();
    const lines = [];
    for (let lineNo = 1; lineNo <= lineCount; lineNo += 1) {
      let productIndex = between(random, 0, ctx.products.length - 1);
      let guard = 0;
      while (chosen.has(productIndex) && guard < 20) {
        productIndex = between(random, 0, ctx.products.length - 1);
        guard += 1;
      }
      chosen.add(productIndex);
      const product = ctx.products[productIndex];
      const qtyMilli = pick(random, [1000, 1000, 1000, 2000, 2000, 3000]);
      const gross = Math.round((qtyMilli * product.price) / 1000);
      let discountType = null;
      let discountValue = 0;
      let discount = 0;
      if (random() < 0.18) {
        discountType = 'pct';
        discountValue = pick(random, [500, 1000, 1500]);
        discount = Math.round((gross * discountValue) / 10_000);
      } else if (random() < 0.06 && gross > 1_000) {
        discountType = 'rs';
        discountValue = Math.min(gross - 1, between(random, 500, 5_000));
        discount = discountValue;
      }
      const net = gross - discount;
      const cost = Math.round((qtyMilli * product.avg_cost) / 1000);
      lines.push({
        product,
        qty_milli: qtyMilli,
        unit_price: product.price,
        gross,
        discount_type: discountType,
        discount_value: discountValue,
        discount,
        net,
        unit_cost_snapshot: product.avg_cost,
        below_cost: net < cost ? 1 : 0,
        warranty_until:
          product.warranty_days > 0
            ? businessDateOf(
                Date.parse(`${date}T00:00:00Z`) + product.warranty_days * DAY,
              )
            : null,
      });
    }
    const subtotal = lines.reduce((sum, line) => sum + line.net, 0);
    let billDiscount = 0;
    let billDiscountType = null;
    let billDiscountValue = 0;
    if (random() < 0.1 && subtotal > 10_000) {
      if (random() < 0.5) {
        billDiscountType = 'pct';
        billDiscountValue = 500;
        billDiscount = Math.round(subtotal * 0.05);
      } else {
        billDiscountType = 'rs';
        billDiscountValue = between(random, 1_000, 10_000);
        billDiscount = Math.min(subtotal - 1, billDiscountValue);
      }
    }
    const raw = subtotal - billDiscount;
    const total = roundTo(raw, 100);
    const rounding = total - raw;
    const billAlloc = allocate(
      billDiscount,
      lines.map((line) => line.net),
    );
    const roundingAlloc =
      rounding !== 0
        ? allocate(
            rounding,
            lines.map((line) => line.net),
          )
        : lines.map(() => 0);

    const roll = random();
    let customer = null;
    let paid = total;
    let udhaar = 0;
    let paymentKind = 'cash';
    if (roll < 0.12) {
      customer = ctx.customers[between(random, 0, ctx.customers.length - 1)];
      udhaar = Math.max(
        100,
        Math.round((total * between(random, 20, 80)) / 100),
      );
      paid = total - udhaar;
      paymentKind = 'cash';
    } else if (roll < 0.17) {
      customer = ctx.customers[between(random, 0, ctx.customers.length - 1)];
      udhaar = total;
      paid = 0;
      paymentKind = 'none';
    } else if (roll < 0.29) {
      paymentKind = 'card';
    } else if (roll < 0.37) {
      paymentKind = 'bank_wallet';
    }

    const payments = [];
    if (paid > 0) {
      const method = paymentKind === 'cash' ? 'cash' : paymentKind;
      let cashTendered = null;
      let change = 0;
      if (method === 'cash') {
        const denomination = pick(random, [1, 1, 1, 5, 10, 100]);
        cashTendered =
          denomination === 1
            ? paid
            : Math.ceil(paid / (denomination * 100)) * denomination * 100;
        change = cashTendered - paid;
      }
      payments.push({
        method,
        amount: paid,
        cash_tendered: cashTendered,
        change_given: method === 'cash' ? change : null,
        reference: method === 'cash' ? '' : `${method.toUpperCase()}-${bill}`,
      });
    }

    // A clean refund of one unit from a fully-paid bill, so the numbers stay exact.
    let refund = null;
    const refundable =
      paid === total &&
      lines[0].product.track_stock === 1 &&
      lines.every((line) => line.discount === 0 && line.net > 0) &&
      billDiscount === 0;
    if (refundable && random() < 0.04) {
      const line = lines[0];
      const whole = lines.length === 1 && line.qty_milli === 1000;
      refund = {
        line,
        amount: line.unit_price,
        kind: whole ? 'whole' : 'partial',
        whole,
        reason: pick(random, [
          'Faulty item',
          'Customer changed mind',
          'Wrong model',
          'Screen issue',
        ]),
        at: at + 30 * 60_000,
      };
    }
    yield {
      bill,
      at,
      date,
      dayIndex,
      staffId: pick(random, staffShare),
      customerId: customer?.id ?? null,
      lines,
      payments,
      subtotal,
      grossTotal: lines.reduce((sum, line) => sum + line.gross, 0),
      itemDiscountTotal: lines.reduce((sum, line) => sum + line.discount, 0),
      billDiscount,
      billDiscountType,
      billDiscountValue,
      rounding,
      total,
      paid,
      udhaar,
      billAlloc,
      roundingAlloc,
      refund,
    };
  }
}

// ---------------------------------------------------------------------------
// main

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = resolve(options.db ?? findLocalD1());
  if (!existsSync(dbPath)) throw new Error(`no SQLite file at ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  assertSchema(db);
  const now = Date.now();
  const ctx = buildContext(options, now);
  const days = makeDays(ctx);
  const insert = rowWriter(db);

  const fkBefore = db.prepare('PRAGMA foreign_key_check').all().length;
  const existing = db
    .prepare('SELECT id FROM tenants WHERE slug = ?1')
    .get(options.tenant);
  const tenantId = existing?.id ?? idAt(now, `tenant:${options.tenant}`);
  const displayName = `Perf Bazaar ${options.tenant}`.slice(0, 60);
  const code = options.code.toUpperCase();
  const normalisedCode = code.replace('-', '');
  ctx.tenantId = tenantId;

  console.log(
    `seeding "${displayName}" (${tenantId}) into ${dbPath}\n` +
      `  ${options.bills.toLocaleString('en-PK')} bills over ${options.days} days, ` +
      `${options.products.toLocaleString('en-PK')} products, ` +
      `${options.customers.toLocaleString('en-PK')} customers`,
  );

  db.exec('PRAGMA foreign_keys = OFF');
  // Throwaway local data: skip the fsync per statement and give SQLite a big page cache.
  db.exec('PRAGMA synchronous = OFF');
  db.exec('PRAGMA cache_size = -131072');
  db.exec('BEGIN');
  try {
    wipeTenant(db, tenantId);

    const tenantRow = {
      id: tenantId,
      slug: options.tenant,
      display_name: displayName,
      status: 'active',
      status_reason: '',
      status_changed_at: null,
      status_changed_by: null,
      db_shard: 'DB',
      daily_write_budget: 19_500,
      poll_after_ms: 60_000,
      restore_epoch: String(now),
      restore_point_at: 0,
      change_log_floor: 0,
      note: 'Local performance shop (tools/seed/perf-shop.mjs)',
      owner_email: null,
      last_owner_export_at: null,
      support_until: null,
      support_reason: '',
      created_by_email: 'operator@example.com',
      created_at: now - options.days * DAY,
      updated_at: now - options.days * DAY,
      deleted_at: null,
      file_bytes: 0,
      files_initialized: 1,
    };
    insert('tenants', tenantRow);

    const start = now - options.days * DAY;
    const owner = {
      id: ctx.ownerId,
      name: 'Adnan Owner',
      role: 'owner',
      ...pinVerifier(options.pin, 'owner'),
      max_discount_bp: 10_000,
      permissions_json: '{}',
      color: 'c1',
      must_change_pin: 0,
      active: 1,
      created_at: start,
      updated_at: start,
      deleted_at: null,
      rev: 1,
      updated_by: null,
    };
    const manager = {
      id: ctx.managerId,
      name: 'Bilal Manager',
      role: 'manager',
      ...pinVerifier('3691', 'manager'),
      max_discount_bp: 2_000,
      permissions_json: '{}',
      color: 'c2',
      must_change_pin: 0,
      active: 1,
      created_at: start,
      updated_at: start,
      deleted_at: null,
      rev: 1,
      updated_by: null,
    };
    const cashiers = [
      { id: ctx.cashierIds[0], name: 'Sana Cashier', pin: '4725', color: 'c3' },
      {
        id: ctx.cashierIds[1],
        name: 'Usman Cashier',
        pin: '5839',
        color: 'c4',
      },
    ].map((person) => ({
      id: person.id,
      name: person.name,
      role: 'cashier',
      ...pinVerifier(person.pin, person.id),
      max_discount_bp: 500,
      permissions_json: '{}',
      color: person.color,
      must_change_pin: 0,
      active: 1,
      created_at: start,
      updated_at: start,
      deleted_at: null,
      rev: 1,
      updated_by: null,
    }));
    for (const member of [owner, manager, ...cashiers])
      insert('staff', { tenant_id: tenantId, ...member });

    insert('branches', {
      tenant_id: tenantId,
      id: ctx.branchId,
      name: 'Main',
      bill_prefix: 'INV',
      address: 'Hall Road, Lahore',
      phone: '+924235761234',
      is_default: 1,
      created_at: start,
      updated_at: start,
      deleted_at: null,
      rev: 1,
      updated_by: null,
    });

    const shop = {
      id: 'shop',
      name: 'Perf Bazaar',
      business_type: 'electronics',
      phone: '+923001234567',
      address: 'Hall Road, Lahore',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      receipt_header: '',
      receipt_footer: 'Shukriya! Phir tashreef laiye.',
      show_payment_details: 1,
      show_cashier_on_receipt: 1,
      logo_key: null,
      tax_rate_bp: 0,
      tax_label: 'Sales tax',
      tax_mode: 'exclusive',
      round_total_to: 100,
      cost_method: 'avg',
      show_cost_on_till: 1,
      number_grouping: 'intl',
      refund_rounding: 'nearest',
      city: 'Lahore',
      ntn: '',
      strn: '',
      receipt_language: 'app',
      show_you_saved: 0,
      print_warranty: 1,
      default_credit_limit: null,
      setup_completed_at: start,
      created_at: start,
      updated_at: start,
      deleted_at: null,
      rev: 1,
      updated_by: owner.id,
      show_shop_name_on_receipt: 1,
      show_logo_on_receipt: 1,
    };
    insert('shop', { tenant_id: tenantId, ...shop });

    const seededDevice = {
      id: ctx.deviceId,
      name: 'Counter 1',
      branch_id: ctx.branchId,
      device_code: 'A',
      token_hash: createHash('sha256')
        .update(`perf-device:${tenantId}`)
        .digest('hex'),
      is_admin: 1,
      kind: 'till',
      expires_at: null,
      read_only_seen_at: null,
      enrolled_at: start,
      enrolled_by: 'operator:perf-seed',
      revoked_at: null,
      last_seen_at: now - 3_600_000,
      last_invoice_seq: options.bills,
      pending_ops: 0,
      oldest_pending_at: null,
      user_agent: 'perf-seed',
      app_version: '1.1.0',
      created_at: start,
      updated_at: now - 3_600_000,
      device_code_history: '',
    };
    insert('devices', { tenant_id: tenantId, ...seededDevice });

    for (const [code, nameEn, nameUr, icon, sortOrder] of EXPENSE_CATEGORIES)
      insert('expense_categories', {
        tenant_id: tenantId,
        id: code,
        code,
        name_en: nameEn,
        name_ur: nameUr,
        icon,
        is_system: 1,
        sort_order: sortOrder,
        created_at: 0,
        updated_at: 0,
        deleted_at: null,
        rev: 1,
        updated_by: null,
      });

    for (const category of ctx.categories)
      insert('categories', {
        tenant_id: tenantId,
        id: category.id,
        name_en: category.name_en,
        name_ur: category.name_ur,
        color: category.color,
        sort_order: category.sort_order,
        created_at: start,
        updated_at: start,
        deleted_at: null,
        rev: 1,
        updated_by: null,
      });

    for (const [index, product] of ctx.products.entries()) {
      insert('products', { tenant_id: tenantId, ...product });
      if (index % 4 !== 3)
        insert('product_barcodes', {
          tenant_id: tenantId,
          id: idAt(start, `barcode:${index}`),
          product_id: product.id,
          barcode: `890${String(1_000_000 + index).padStart(10, '0')}`,
          created_at: start,
          updated_at: start,
          deleted_at: null,
          rev: 1,
          updated_by: null,
        });
    }
    for (const bundle of ctx.bundles)
      insert('products', { tenant_id: tenantId, ...bundle });
    for (const item of ctx.bundleItems)
      insert('bundle_items', { tenant_id: tenantId, ...item });

    for (const [index, customer] of ctx.customers.entries()) {
      insert('customers', { tenant_id: tenantId, ...customer });
      // Opening khata for one customer in six.
      if (index % 6 === 0) {
        const amount = between(
          rng(`${options.seed}:opening:${index}`),
          1,
          50_000,
        );
        insert('ledger_entries', {
          tenant_id: tenantId,
          id: idAt(start, `customer-opening:${index}`),
          party_type: 'customer',
          party_id: customer.id,
          amount,
          source_type: 'opening',
          source_id: null,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: owner.id,
          business_date: days[days.length - 1].date,
          created_at: start,
        });
      }
    }

    for (const [index, supplier] of ctx.suppliers.entries()) {
      insert('suppliers', { tenant_id: tenantId, ...supplier });
      if (index % 3 === 0) {
        const amount = between(
          rng(`${options.seed}:sup-opening:${index}`),
          1,
          200_000,
        );
        insert('ledger_entries', {
          tenant_id: tenantId,
          id: idAt(start, `supplier-opening:${index}`),
          party_type: 'supplier',
          party_id: supplier.id,
          amount,
          source_type: 'opening',
          source_id: null,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: owner.id,
          business_date: days[days.length - 1].date,
          created_at: start,
        });
      }
    }

    // ---- opening stock and deliveries -------------------------------------

    const soldUnits = new Map();
    for (const bill of billStream(ctx, days))
      for (const line of bill.lines) {
        if (line.product.track_stock !== 1) continue;
        soldUnits.set(
          line.product.id,
          (soldUnits.get(line.product.id) ?? 0) + line.qty_milli,
        );
      }

    /** Inserts a movement and keeps the product cache the server would derive. */
    const stockTotals = new Map();
    const addMovement = (row) => {
      insert('stock_movements', row);
      stockTotals.set(
        row.product_id,
        (stockTotals.get(row.product_id) ?? 0) + row.qty_delta_milli,
      );
    };

    const openingRandom = rng(`${options.seed}:opening-stock`);
    for (const product of ctx.products) {
      if (product.track_stock !== 1) continue;
      const sold = soldUnits.get(product.id) ?? 0;
      const qty = sold + between(openingRandom, 20, 60) * 1000;
      addMovement({
        tenant_id: tenantId,
        id: idAt(start - DAY, `opening:${product.id}`),
        product_id: product.id,
        qty_delta_milli: qty,
        reason_code: 'opening',
        ref_type: 'opening',
        ref_id: null,
        unit_cost: product.last_cost,
        note: '',
        branch_id: ctx.branchId,
        device_id: ctx.deviceId,
        staff_id: owner.id,
        business_date: days[days.length - 1].date,
        created_at: start - DAY,
      });
    }

    /** Cash-drawer totals per business date (07 §8). */
    const drawer = new Map();
    const drawerFor = (date) => {
      let row = drawer.get(date);
      if (!row) {
        row = {
          cash_sales: 0,
          udhaar_cash_in: 0,
          pay_ins: 0,
          pay_outs: 0,
          cash_refunds: 0,
          cash_expenses: 0,
          supplier_cash_out: 0,
          supplier_cash_in: 0,
          card_total: 0,
          bank_total: 0,
          udhaar_given: 0,
          bills: 0,
          refunds: 0,
        };
        drawer.set(date, row);
      }
      return row;
    };

    const purchaseRandom = rng(`${options.seed}:purchases`);
    const purchaseLines = new Map();
    for (let i = 0; i < options.purchases; i += 1) {
      const dayIndex = between(purchaseRandom, 0, days.length - 1);
      const day = days[dayIndex];
      const at = day.start + between(purchaseRandom, 9, 18) * 3_600_000;
      if (at > now) continue;
      const supplier =
        ctx.suppliers[between(purchaseRandom, 0, ctx.suppliers.length - 1)];
      const id = idAt(at, `purchase:${i}`);
      const lines = [];
      const used = new Set();
      const lineCount = between(purchaseRandom, 1, 8);
      for (let lineNo = 1; lineNo <= lineCount; lineNo += 1) {
        let productIndex = between(purchaseRandom, 0, ctx.products.length - 1);
        while (used.has(productIndex))
          productIndex = between(purchaseRandom, 0, ctx.products.length - 1);
        used.add(productIndex);
        const product = ctx.products[productIndex];
        const qtyMilli = between(purchaseRandom, 5, 60) * 1000;
        const unitCost = Math.round(
          (product.last_cost * between(purchaseRandom, 96, 104)) / 100,
        );
        const lineTotal = Math.round((qtyMilli * unitCost) / 1000);
        lines.push({
          id: idAt(at, `purchase-line:${i}:${lineNo}`),
          line_no: lineNo,
          product,
          qty_milli: qtyMilli,
          unit_cost: unitCost,
          line_total: lineTotal,
        });
      }
      const total = lines.reduce((sum, line) => sum + line.line_total, 0);
      const paidRoll = purchaseRandom();
      const paidNow =
        paidRoll < 0.55 ? total : paidRoll < 0.75 ? Math.round(total / 2) : 0;
      const paidMethod =
        paidNow === 0 ? null : purchaseRandom() < 0.6 ? 'cash' : 'bank_wallet';
      insert('purchases', {
        tenant_id: tenantId,
        id,
        supplier_id: supplier.id,
        supplier_invoice_no: `WS-${String(i + 1).padStart(5, '0')}`,
        other_charges: 0,
        total,
        paid_now: paidNow,
        paid_method: paidMethod,
        line_count: lines.length,
        note: '',
        branch_id: ctx.branchId,
        device_id: ctx.deviceId,
        staff_id: ctx.staffIds[i % ctx.staffIds.length],
        business_date: day.date,
        created_at: at,
      });
      for (const line of lines) {
        insert('purchase_lines', {
          tenant_id: tenantId,
          id: line.id,
          purchase_id: id,
          line_no: line.line_no,
          product_id: line.product.id,
          qty_milli: line.qty_milli,
          unit_cost: line.unit_cost,
          line_total: line.line_total,
          charges_alloc: 0,
          landed_unit_cost: line.unit_cost,
          created_at: at,
        });
        if (line.product.track_stock === 1)
          addMovement({
            tenant_id: tenantId,
            id: idAt(at, `purchase-move:${i}:${line.line_no}`),
            product_id: line.product.id,
            qty_delta_milli: line.qty_milli,
            reason_code: 'purchase',
            ref_type: 'purchase',
            ref_id: id,
            unit_cost: line.unit_cost,
            note: '',
            branch_id: ctx.branchId,
            device_id: ctx.deviceId,
            staff_id: ctx.staffIds[i % ctx.staffIds.length],
            business_date: day.date,
            created_at: at,
          });
      }
      purchaseLines.set(id, {
        at,
        day,
        supplier,
        lines,
        paidNow,
        paidMethod,
      });
      if (paidNow > 0 && paidMethod === 'cash')
        drawerFor(day.date).supplier_cash_out += paidNow;
      insert('ledger_entries', {
        tenant_id: tenantId,
        id: idAt(at, `purchase-ledger:${i}`),
        party_type: 'supplier',
        party_id: supplier.id,
        amount: total,
        source_type: 'purchase',
        source_id: id,
        note: `WS-${String(i + 1).padStart(5, '0')}`,
        branch_id: ctx.branchId,
        device_id: ctx.deviceId,
        staff_id: ctx.staffIds[i % ctx.staffIds.length],
        business_date: day.date,
        created_at: at,
      });
      if (paidNow > 0 && paidMethod) {
        const paymentId = idAt(at, `purchase-payment:${i}`);
        insert('payments', {
          tenant_id: tenantId,
          id: paymentId,
          direction: 'out',
          method: paidMethod,
          purpose: 'purchase_paid_now',
          amount: paidNow,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: null,
          refund_id: null,
          purchase_id: id,
          supplier_return_id: null,
          party_type: 'supplier',
          party_id: supplier.id,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: ctx.staffIds[i % ctx.staffIds.length],
          business_date: day.date,
          created_at: at,
        });
        insert('ledger_entries', {
          tenant_id: tenantId,
          id: idAt(at, `purchase-payment-ledger:${i}`),
          party_type: 'supplier',
          party_id: supplier.id,
          amount: -paidNow,
          source_type: 'payment',
          source_id: paymentId,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: ctx.staffIds[i % ctx.staffIds.length],
          business_date: day.date,
          created_at: at,
        });
      }
    }

    // ---- bills, payments, refunds ----------------------------------------

    const customerDebits = new Map();
    for (const bill of billStream(ctx, days)) {
      const {
        bill: number,
        at,
        date,
        staffId,
        customerId,
        lines,
        payments,
        subtotal,
        grossTotal,
        itemDiscountTotal,
        billDiscount,
        billDiscountType,
        billDiscountValue,
        rounding,
        total,
        paid,
        udhaar,
        billAlloc,
        roundingAlloc,
        refund,
      } = bill;
      const saleId = idAt(at, `sale:${number}`);
      const status = refund
        ? refund.whole
          ? 'refunded'
          : 'part_refunded'
        : 'paid';
      insert('sales', {
        tenant_id: tenantId,
        id: saleId,
        invoice_no: `INV-A-${number}`,
        invoice_seq: number,
        branch_id: ctx.branchId,
        device_id: ctx.deviceId,
        staff_id: staffId,
        customer_id: customerId,
        business_date: date,
        created_at: at,
        line_count: lines.length,
        items_qty_milli: lines.reduce((sum, line) => sum + line.qty_milli, 0),
        gross_total: grossTotal,
        item_discount_total: itemDiscountTotal,
        subtotal,
        bill_discount_type: billDiscountType,
        bill_discount_value: billDiscountValue,
        bill_discount: billDiscount,
        tax_rate_bp: 0,
        tax: 0,
        tax_inclusive: 0,
        rounding,
        total,
        paid_total: paid,
        udhaar_amount: udhaar,
        cash_tendered: payments[0]?.cash_tendered ?? 0,
        change_given: payments[0]?.change_given ?? 0,
        status,
        replaces_sale_id: null,
        note: '',
        bundle_discount_total: 0,
      });
      lines.forEach((line, index) => {
        insert('sale_lines', {
          tenant_id: tenantId,
          id: idAt(at, `sale-line:${number}:${index + 1}`),
          sale_id: saleId,
          line_no: index + 1,
          product_id: line.product.id,
          name_snapshot: line.product.name_en,
          sku_snapshot: line.product.sku,
          qty_milli: line.qty_milli,
          unit_price: line.unit_price,
          gross: line.gross,
          discount_type: line.discount_type,
          discount_value: line.discount_value,
          discount: line.discount,
          net: line.net,
          bill_discount_alloc: billAlloc[index] ?? 0,
          tax_alloc: 0,
          rounding_alloc: roundingAlloc[index] ?? 0,
          unit_cost_snapshot: line.unit_cost_snapshot,
          below_cost: line.below_cost,
          serial: null,
          warranty_until: line.warranty_until,
          created_at: at,
          business_date: date,
        });
        if (line.product.track_stock === 1)
          addMovement({
            tenant_id: tenantId,
            id: idAt(at, `sale-move:${number}:${index + 1}`),
            product_id: line.product.id,
            qty_delta_milli: -line.qty_milli,
            reason_code: 'sale',
            ref_type: 'sale',
            ref_id: saleId,
            unit_cost: null,
            note: '',
            branch_id: ctx.branchId,
            device_id: ctx.deviceId,
            staff_id: staffId,
            business_date: date,
            created_at: at,
          });
      });
      for (const [index, payment] of payments.entries()) {
        insert('payments', {
          tenant_id: tenantId,
          id: idAt(at, `sale-payment:${number}:${index + 1}`),
          direction: 'in',
          method: payment.method,
          purpose: 'sale',
          amount: payment.amount,
          cash_tendered: payment.cash_tendered,
          change_given: payment.change_given,
          reference: payment.reference,
          sale_id: saleId,
          refund_id: null,
          purchase_id: null,
          supplier_return_id: null,
          party_type: null,
          party_id: null,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: staffId,
          business_date: date,
          created_at: at,
        });
      }
      if (udhaar > 0 && customerId) {
        insert('ledger_entries', {
          tenant_id: tenantId,
          id: idAt(at, `sale-ledger:${number}`),
          party_type: 'customer',
          party_id: customerId,
          amount: udhaar,
          source_type: 'sale',
          source_id: saleId,
          note: `INV-A-${number}`,
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: staffId,
          business_date: date,
          created_at: at,
        });
        customerDebits.set(
          customerId,
          (customerDebits.get(customerId) ?? 0) + udhaar,
        );
      }
      if (refund) {
        const refundId = idAt(refund.at, `refund:${number}`);
        insert('refunds', {
          tenant_id: tenantId,
          id: refundId,
          sale_id: saleId,
          kind: refund.kind,
          reason: refund.reason,
          method: 'cash',
          exact_amount: refund.amount,
          udhaar_part: 0,
          rounding: 0,
          amount: refund.amount,
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: staffId,
          business_date: date,
          created_at: refund.at,
        });
        insert('refund_lines', {
          tenant_id: tenantId,
          id: idAt(refund.at, `refund-line:${number}`),
          refund_id: refundId,
          sale_line_id: idAt(at, `sale-line:${number}:1`),
          qty_milli: 1000,
          amount: refund.amount,
          restock: 1,
          created_at: refund.at,
        });
        insert('payments', {
          tenant_id: tenantId,
          id: idAt(refund.at, `refund-payment:${number}`),
          direction: 'out',
          method: 'cash',
          purpose: 'refund',
          amount: refund.amount,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: saleId,
          refund_id: refundId,
          purchase_id: null,
          supplier_return_id: null,
          party_type: customerId ? 'customer' : null,
          party_id: customerId,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: staffId,
          business_date: date,
          created_at: refund.at,
        });
        addMovement({
          tenant_id: tenantId,
          id: idAt(refund.at, `refund-move:${number}`),
          product_id: refund.line.product.id,
          qty_delta_milli: 1000,
          reason_code: 'refund_return',
          ref_type: 'refund',
          ref_id: refundId,
          unit_cost: null,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: staffId,
          business_date: date,
          created_at: refund.at,
        });
        insert('audit_log', {
          tenant_id: tenantId,
          id: idAt(refund.at, `refund-audit:${number}`),
          action: 'refund.create',
          entity: 'refunds',
          entity_id: refundId,
          before_json: null,
          after_json: JSON.stringify({
            invoice: `INV-A-${number}`,
            amount: refund.amount,
          }),
          device_id: ctx.deviceId,
          staff_id: staffId,
          created_at: refund.at,
        });
      }
      const row = drawerFor(date);
      row.bills += 1;
      row.udhaar_given += udhaar;
      for (const payment of payments) {
        if (payment.method === 'cash') row.cash_sales += payment.amount;
        else if (payment.method === 'card') row.card_total += payment.amount;
        else if (payment.method === 'bank_wallet')
          row.bank_total += payment.amount;
      }
      if (refund) {
        row.refunds += 1;
        row.cash_refunds += refund.amount;
      }
    }

    // ---- udhaar collection, expenses, cash moves -------------------------

    const collectionRandom = rng(`${options.seed}:collections`);
    for (const customer of ctx.customers) {
      let outstanding = customerDebits.get(customer.id) ?? 0;
      if (outstanding <= 0) continue;
      const paymentsCount = between(collectionRandom, 0, 5);
      for (let i = 0; i < paymentsCount; i += 1) {
        const at =
          now -
          between(collectionRandom, 0, 30) * DAY -
          between(collectionRandom, 1, 20) * 3_600_000;
        const amount = Math.min(
          outstanding,
          between(collectionRandom, 500, 20_000),
        );
        if (amount <= 0) break;
        outstanding -= amount;
        const date = businessDateOf(at);
        const method = collectionRandom() < 0.82 ? 'cash' : 'card';
        const paymentId = idAt(at, `collection:${customer.id}:${i}`);
        insert('payments', {
          tenant_id: tenantId,
          id: paymentId,
          direction: 'in',
          method,
          purpose: 'customer_payment',
          amount,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: null,
          refund_id: null,
          purchase_id: null,
          supplier_return_id: null,
          party_type: 'customer',
          party_id: customer.id,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: owner.id,
          business_date: date,
          created_at: at,
        });
        insert('ledger_entries', {
          tenant_id: tenantId,
          id: idAt(at, `collection-ledger:${customer.id}:${i}`),
          party_type: 'customer',
          party_id: customer.id,
          amount: -amount,
          source_type: 'payment',
          source_id: paymentId,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: owner.id,
          business_date: date,
          created_at: at,
        });
        if (method === 'cash') drawerFor(date).udhaar_cash_in += amount;
      }
      if (outstanding > 0 && collectionRandom() < 0.12) {
        const promisedOn = businessDateOf(
          now + between(collectionRandom, 1, 20) * DAY,
        );
        const at = now - between(collectionRandom, 0, 20) * DAY;
        insert('promises', {
          tenant_id: tenantId,
          id: idAt(at, `promise:${customer.id}`),
          customer_id: customer.id,
          promised_on: promisedOn,
          amount: collectionRandom() < 0.5 ? outstanding : null,
          status: pick(collectionRandom, ['open', 'open', 'open', 'kept']),
          note: '',
          created_at: at,
          updated_at: at,
          deleted_at: null,
          rev: 1,
          updated_by: null,
        });
      }
    }

    const expenseRandom = rng(`${options.seed}:expenses`);
    for (let i = 0; i < options.expenses; i += 1) {
      const dayIndex = between(expenseRandom, 0, days.length - 1);
      const day = days[dayIndex];
      const at = day.start + between(expenseRandom, 9, 21) * 3_600_000;
      if (at > now) continue;
      const [code] =
        EXPENSE_CATEGORIES[
          between(expenseRandom, 0, EXPENSE_CATEGORIES.length - 1)
        ];
      const method = expenseRandom() < 0.75 ? 'cash' : 'card';
      const amount = between(expenseRandom, 500, 100_000);
      insert('expenses', {
        tenant_id: tenantId,
        id: idAt(at, `expense:${i}`),
        category_id: code,
        amount,
        method,
        payee: pick(expenseRandom, EXPENSE_PAYEES),
        note: '',
        reverses_id: null,
        branch_id: ctx.branchId,
        device_id: ctx.deviceId,
        staff_id: owner.id,
        business_date: day.date,
        created_at: at,
      });
      if (method === 'cash') drawerFor(day.date).cash_expenses += amount;
    }

    const cashRandom = rng(`${options.seed}:cash-moves`);
    for (let i = 0; i < 150; i += 1) {
      const dayIndex = between(cashRandom, 0, Math.min(days.length - 1, 60));
      const day = days[dayIndex];
      const at = day.start + between(cashRandom, 10, 20) * 3_600_000;
      if (at > now) continue;
      const kind = cashRandom() < 0.5 ? 'pay_in' : 'pay_out';
      const amount = between(cashRandom, 10_000, 500_000);
      insert('cash_moves', {
        tenant_id: tenantId,
        id: idAt(at, `cash-move:${i}`),
        kind,
        amount,
        reason:
          kind === 'pay_in'
            ? pick(cashRandom, ['Change fund', 'Owner brought cash'])
            : pick(cashRandom, [
                'Bank deposit',
                'Petty cash',
                'Tea and snacks',
              ]),
        branch_id: ctx.branchId,
        device_id: ctx.deviceId,
        staff_id: owner.id,
        business_date: day.date,
        created_at: at,
      });
      const row = drawerFor(day.date);
      if (kind === 'pay_in') row.pay_ins += amount;
      else row.pay_outs += amount;
    }

    // ---- supplier returns -------------------------------------------------

    const returnRandom = rng(`${options.seed}:supplier-returns`);
    const purchases = [...purchaseLines.entries()];
    for (let i = 0; i < Math.min(40, purchases.length); i += 1) {
      const [purchaseId, purchase] =
        purchases[between(returnRandom, 0, purchases.length - 1)];
      const day = purchase.day;
      const at = purchase.at + between(returnRandom, 1, 40) * DAY;
      if (at > now) continue;
      const lines = purchase.lines
        .slice(0, between(returnRandom, 1, Math.min(3, purchase.lines.length)))
        .map((line, index) => {
          const qtyMilli = Math.min(
            line.qty_milli,
            between(returnRandom, 1, 5) * 1000,
          );
          return {
            index,
            line,
            qtyMilli,
            lineTotal: Math.round((qtyMilli * line.unit_cost) / 1000),
          };
        })
        .filter((line) => line.qtyMilli > 0);
      if (lines.length === 0) continue;
      const id = idAt(at, `supplier-return:${i}`);
      const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
      if (total <= 0) continue;
      const refundReceived = returnRandom() < 0.5 ? Math.round(total / 2) : 0;
      insert('supplier_returns', {
        tenant_id: tenantId,
        id,
        supplier_id: purchase.supplier.id,
        purchase_id: purchaseId,
        reason: pick(returnRandom, ['Damaged', 'Wrong model', 'Dead stock']),
        total,
        refund_received: refundReceived,
        refund_method: refundReceived > 0 ? 'cash' : null,
        line_count: lines.length,
        note: '',
        branch_id: ctx.branchId,
        device_id: ctx.deviceId,
        staff_id: owner.id,
        business_date: day.date,
        created_at: at,
      });
      for (const line of lines) {
        insert('supplier_return_lines', {
          tenant_id: tenantId,
          id: idAt(at, `supplier-return-line:${i}:${line.index}`),
          return_id: id,
          line_no: line.index + 1,
          product_id: line.line.product.id,
          purchase_line_id: line.line.id,
          qty_milli: line.qtyMilli,
          unit_credit: line.line.unit_cost,
          line_total: line.lineTotal,
          cost_snapshot: line.line.product.avg_cost,
          created_at: at,
        });
        if (line.line.product.track_stock === 1)
          addMovement({
            tenant_id: tenantId,
            id: idAt(at, `supplier-return-move:${i}:${line.index}`),
            product_id: line.line.product.id,
            qty_delta_milli: -line.qtyMilli,
            reason_code: 'supplier_return',
            ref_type: 'supplier_return',
            ref_id: id,
            unit_cost: null,
            note: '',
            branch_id: ctx.branchId,
            device_id: ctx.deviceId,
            staff_id: owner.id,
            business_date: day.date,
            created_at: at,
          });
      }
      insert('ledger_entries', {
        tenant_id: tenantId,
        id: idAt(at, `supplier-return-ledger:${i}`),
        party_type: 'supplier',
        party_id: purchase.supplier.id,
        amount: -total,
        source_type: 'supplier_return',
        source_id: id,
        note: '',
        branch_id: ctx.branchId,
        device_id: ctx.deviceId,
        staff_id: owner.id,
        business_date: day.date,
        created_at: at,
      });
      if (refundReceived > 0) {
        const paymentId = idAt(at, `supplier-refund:${i}`);
        insert('payments', {
          tenant_id: tenantId,
          id: paymentId,
          direction: 'in',
          method: 'cash',
          purpose: 'supplier_refund',
          amount: refundReceived,
          cash_tendered: null,
          change_given: null,
          reference: '',
          sale_id: null,
          refund_id: null,
          purchase_id: null,
          supplier_return_id: id,
          party_type: 'supplier',
          party_id: purchase.supplier.id,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: owner.id,
          business_date: day.date,
          created_at: at,
        });
        insert('ledger_entries', {
          tenant_id: tenantId,
          id: idAt(at, `supplier-refund-ledger:${i}`),
          party_type: 'supplier',
          party_id: purchase.supplier.id,
          amount: refundReceived,
          source_type: 'payment',
          source_id: paymentId,
          note: '',
          branch_id: ctx.branchId,
          device_id: ctx.deviceId,
          staff_id: owner.id,
          business_date: day.date,
          created_at: at,
        });
        drawerFor(day.date).supplier_cash_in += refundReceived;
      }
    }

    // ---- day closes (this device, last n days, today left open) -----------

    let openingCash = 100_000;
    const closeDays = Math.min(options.closes, days.length - 1);
    for (let i = closeDays; i >= 1; i -= 1) {
      const day = days[i];
      const row = drawer.get(day.date);
      if (!row) continue;
      const expected =
        openingCash +
        row.cash_sales +
        row.udhaar_cash_in +
        row.pay_ins +
        row.supplier_cash_in -
        row.cash_refunds -
        row.cash_expenses -
        row.supplier_cash_out -
        row.pay_outs;
      const delta =
        rng(`${options.seed}:close:${i}`)() < 0.85
          ? 0
          : between(rng(`${options.seed}:close-delta:${i}`), -200, 200);
      const counted = Math.max(0, expected + delta);
      insert('day_closes', {
        tenant_id: tenantId,
        id: idAt(day.end, `close:${i}`),
        device_id: ctx.deviceId,
        branch_id: ctx.branchId,
        staff_id: owner.id,
        business_date: day.date,
        period_start: day.start,
        period_end: day.end,
        opening_cash: openingCash,
        cash_sales: row.cash_sales,
        udhaar_cash_in: row.udhaar_cash_in,
        pay_ins: row.pay_ins,
        supplier_cash_in: row.supplier_cash_in,
        cash_refunds: row.cash_refunds,
        cash_expenses: row.cash_expenses,
        supplier_cash_out: row.supplier_cash_out,
        pay_outs: row.pay_outs,
        expected_cash: expected,
        counted_cash: counted,
        difference: counted - expected,
        denominations_json: null,
        note: '',
        created_at: day.end,
        card_total: row.card_total,
        bank_total: row.bank_total,
        udhaar_given: row.udhaar_given,
        bills: row.bills,
        refunds: row.refunds,
      });
      insert('audit_log', {
        tenant_id: tenantId,
        id: idAt(day.end, `close-audit:${i}`),
        action: 'day_close',
        entity: 'day_closes',
        entity_id: idAt(day.end, `close:${i}`),
        before_json: null,
        after_json: JSON.stringify({ difference: counted - expected }),
        device_id: ctx.deviceId,
        staff_id: owner.id,
        created_at: day.end,
      });
      openingCash = counted;
    }

    // ---- derived stock cache ---------------------------------------------

    const setStock = db.prepare(
      `UPDATE products SET on_hand_milli = ?2, cost_changed_at = created_at
        WHERE tenant_id = ?1 AND id = ?3`,
    );
    for (const [productId, onHand] of stockTotals)
      setStock.run(tenantId, onHand, productId);

    // ---- enrolment code ---------------------------------------------------

    db.prepare(
      `INSERT INTO enrolment_codes
         (code_hash, tenant_id, device_name, branch_id, grants_admin, kind,
          created_by, created_at, expires_at, used_at, device_id)
       VALUES (?1, ?2, 'Counter 2', ?3, 1, 'till', 'operator:perf-seed',
               ?4, ?5, NULL, NULL)`,
    ).run(
      createHmac('sha256', OWNER_CODE_KEY)
        .update(`enrol:${normalisedCode}`)
        .digest('hex'),
      tenantId,
      ctx.branchId,
      now,
      now + 365 * DAY,
    );

    // ---- change-log anchor: force a snapshot, and keep the cursor behind
    // the next real change_log row.

    const anchorSeq = Number(
      db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log').get()
        .seq,
    );
    const nextSeq = anchorSeq + 1;
    insert('change_log', {
      seq: nextSeq,
      tenant_id: tenantId,
      tbl: 'shop',
      row_id: 'shop',
      op: 'upsert',
      row_json: JSON.stringify(shop),
      device_id: null,
      at: now,
    });
    db.prepare('UPDATE tenants SET change_log_floor = ?2 WHERE id = ?1').run(
      tenantId,
      nextSeq,
    );

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const fkAfter = db.prepare('PRAGMA foreign_key_check').all().length;
  if (fkAfter > fkBefore)
    console.warn(
      `warning: ${fkAfter - fkBefore} foreign-key problems appeared while seeding`,
    );

  const counts = countByTenant(db, tenantId);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const size = statSync(dbPath).size;
  db.close();

  console.log(`\nseeded ${total.toLocaleString('en-PK')} rows`);
  for (const [table, value] of Object.entries(counts))
    if (value > 0)
      console.log(`  ${table.padEnd(22)} ${String(value).padStart(9)}`);
  console.log(`  ${'database'.padEnd(22)} ${(size / 1_048_576).toFixed(1)} MB`);

  console.log(`
Owner PIN  ${options.pin}  (Bilal ${'\u2014'} manager 3691, Sana ${'\u2014'} cashier 4725, Usman ${'\u2014'} cashier 5839)
Enrol code ${code}   (single use; re-run this script to get a fresh one)
Tenant     ${tenantId}  slug ${options.tenant}

Start the API, then open the enrol link:
  pnpm --filter @bikri/pos build
  pnpm --filter @bikri/api exec wrangler d1 migrations apply bikri --local
  pnpm --filter @bikri/api exec wrangler dev --port 8787 --local-upstream localhost:8787 \\
    --var ALLOWED_ORIGINS:http://localhost:8787,http://localhost:5173 \\
    --var OWNER_CODE_KEY:${OWNER_CODE_KEY} \\
    --var OWNER_SESSION_KEY:${OWNER_SESSION_KEY}

  http://localhost:8787/bikri/enrol?code=${normalisedCode}
`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main();
