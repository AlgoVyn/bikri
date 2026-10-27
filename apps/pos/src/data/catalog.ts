import { businessDate, generateSku, newId, type OpRow } from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import { defaultBranch, deviceInfo } from './localTenant.ts';
import {
  createProduct,
  type LedgerContext,
  type NewProduct,
} from './products.ts';
import { type WriteOptions, type Writer, writeAction } from './write.ts';

const DAY_MS = 86_400_000;

export type StockFilter = 'all' | 'low' | 'out' | 'untracked';
export type ProductSort = 'name' | 'price' | 'stock' | 'best';

export type ProductListRow = {
  product: MasterRow;
  category: MasterRow | null;
  onHand: number;
  sold30: number;
  barcodes: string[];
  stockState: 'ok' | 'low' | 'out' | 'untracked';
};

export class DuplicateBarcodeError extends Error {
  readonly barcode: string;
  readonly ownerName: string;
  constructor(barcode: string, ownerName: string) {
    super(`Barcode ${barcode} is already used by ${ownerName}`);
    this.name = 'DuplicateBarcodeError';
    this.barcode = barcode;
    this.ownerName = ownerName;
  }
}

export class DuplicateSkuError extends Error {
  readonly sku: string;
  constructor(sku: string) {
    super(`SKU ${sku} is already used`);
    this.name = 'DuplicateSkuError';
    this.sku = sku;
  }
}

export class ProductInUseError extends Error {
  constructor() {
    super('Product is referenced by an unsynced op');
    this.name = 'ProductInUseError';
  }
}

export class CategoryInUseError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(`Category has ${count} active products`);
    this.name = 'CategoryInUseError';
    this.count = count;
  }
}

const live = <T extends { deleted_at?: unknown }>(rows: T[]) =>
  rows.filter((r) => !r.deleted_at);

export function stockStateOf(
  product: MasterRow,
  onHand: number,
): ProductListRow['stockState'] {
  if (product.track_stock !== 1) return 'untracked';
  if (onHand <= 0) return 'out';
  const min = Number(product.min_stock_milli ?? 0);
  return min > 0 && onHand <= min ? 'low' : 'ok';
}

/** Qty sold per product over the last `days` business days, net of refunds. */
export async function soldByProduct(
  db: BikriDb,
  days: number,
  now = Date.now(),
): Promise<Map<string, number>> {
  const from = businessDate(now - (days - 1) * DAY_MS);
  const to = businessDate(now);
  const sold = new Map<string, number>();
  const sales = await db.sales
    .where('business_date')
    .between(from, to, true, true)
    .toArray();
  for (const sale of sales) {
    if (sale.status === 'void') continue;
    for (const line of await db.sale_lines
      .where('sale_id')
      .equals(sale.id)
      .toArray()) {
      if (!line.product_id) continue;
      const id = String(line.product_id);
      sold.set(id, (sold.get(id) ?? 0) + Number(line.qty_milli));
    }
  }
  return sold;
}

/** Every word must appear in the name (either language), brand, SKU or a barcode (screens/08). */
export function matchesQuery(row: ProductListRow, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const p = row.product;
  const haystack = [p.name_en, p.name_ur, p.brand, p.sku, ...row.barcodes]
    .map((v) => String(v ?? '').toLowerCase())
    .join(' ');
  return words.every((w) => haystack.includes(w));
}

export async function listProducts(
  db: BikriDb,
  opts: {
    query?: string;
    categoryId?: string | null;
    stock?: StockFilter;
    sort?: ProductSort;
    now?: number;
  } = {},
): Promise<ProductListRow[]> {
  const products = live(await db.products.toArray());
  const categories = new Map(
    live(await db.categories.toArray()).map((c) => [c.id, c]),
  );
  const barcodes = new Map<string, string[]>();
  for (const b of live(await db.product_barcodes.toArray())) {
    const id = String(b.product_id);
    barcodes.set(id, [...(barcodes.get(id) ?? []), String(b.barcode)]);
  }
  const levels = new Map(
    (await db.stock_levels.toArray()).map((l) => [
      l.product_id,
      l.on_hand_milli,
    ]),
  );
  const sold = await soldByProduct(db, 30, opts.now);
  let rows: ProductListRow[] = products.map((product) => {
    const onHand = levels.get(product.id) ?? 0;
    return {
      product,
      category: categories.get(String(product.category_id)) ?? null,
      onHand,
      sold30: sold.get(product.id) ?? 0,
      barcodes: barcodes.get(product.id) ?? [],
      stockState: stockStateOf(product, onHand),
    };
  });
  if (opts.query) rows = rows.filter((r) => matchesQuery(r, opts.query ?? ''));
  if (opts.categoryId)
    rows = rows.filter((r) => r.product.category_id === opts.categoryId);
  const stock = opts.stock ?? 'all';
  if (stock === 'low') rows = rows.filter((r) => r.stockState === 'low');
  if (stock === 'out') rows = rows.filter((r) => r.stockState === 'out');
  if (stock === 'untracked')
    rows = rows.filter((r) => r.stockState === 'untracked');
  const byName = (a: ProductListRow, b: ProductListRow) =>
    String(a.product.name_en).localeCompare(String(b.product.name_en));
  const sort = opts.sort ?? 'name';
  rows.sort((a, b) => {
    if (sort === 'price')
      return Number(a.product.price) - Number(b.product.price) || byName(a, b);
    if (sort === 'stock') return a.onHand - b.onHand || byName(a, b);
    if (sort === 'best') return b.sold30 - a.sold30 || byName(a, b);
    return byName(a, b);
  });
  return rows;
}

export type HistoryRow = {
  movement: SyncedRow;
  balanceAfter: number;
  staffName: string;
};

export type ProductDetail = {
  product: MasterRow;
  category: MasterRow | null;
  barcodes: MasterRow[];
  onHand: number;
  history: HistoryRow[];
  /** Oldest first: 14 business days of qty sold. */
  last14: { date: string; qty: number; revenue: number }[];
};

export async function productDetail(
  db: BikriDb,
  id: string,
  now = Date.now(),
): Promise<ProductDetail | null> {
  const product = await db.products.get(id);
  if (!product || product.deleted_at) return null;
  const category = product.category_id
    ? ((await db.categories.get(String(product.category_id))) ?? null)
    : null;
  const barcodes = live(
    await db.product_barcodes.where('product_id').equals(id).toArray(),
  );
  const movements = await db.stock_movements
    .where('[product_id+created_at]')
    .between([id, 0], [id, Infinity])
    .toArray();
  const staff = new Map(
    (await db.staff.toArray()).map((s) => [s.id, String(s.name ?? '')]),
  );
  let balance = 0;
  const history: HistoryRow[] = movements.map((movement) => {
    balance += Number(movement.qty_delta_milli);
    return {
      movement,
      balanceAfter: balance,
      staffName: staff.get(String(movement.staff_id)) ?? '',
    };
  });
  history.reverse();
  const days: ProductDetail['last14'] = [];
  for (let i = 13; i >= 0; i -= 1)
    days.push({ date: businessDate(now - i * DAY_MS), qty: 0, revenue: 0 });
  const first = days[0]?.date ?? '';
  const last = days[13]?.date ?? '';
  const sales = await db.sales
    .where('business_date')
    .between(first, last, true, true)
    .toArray();
  const byId = new Map(
    sales.filter((s) => s.status !== 'void').map((s) => [s.id, s]),
  );
  for (const line of await db.sale_lines
    .where('product_id')
    .equals(id)
    .toArray()) {
    const sale = byId.get(String(line.sale_id));
    if (!sale) continue;
    const day = days.find((d) => d.date === sale.business_date);
    if (!day) continue;
    day.qty += Number(line.qty_milli);
    day.revenue += Number(line.net) - Number(line.bill_discount_alloc ?? 0);
  }
  return {
    product,
    category,
    barcodes,
    onHand: (await db.stock_levels.get(id))?.on_hand_milli ?? 0,
    history,
    last14: days,
  };
}

/** The active product already using `barcode`, if any (other than `exceptProductId`). */
export async function barcodeOwner(
  db: BikriDb,
  barcode: string,
  exceptProductId?: string,
): Promise<MasterRow | null> {
  const code = barcode.trim();
  for (const row of live(
    await db.product_barcodes.where('barcode').equals(code).toArray(),
  )) {
    if (row.product_id === exceptProductId) continue;
    const owner = await db.products.get(String(row.product_id));
    if (owner && !owner.deleted_at) return owner;
  }
  return null;
}

export async function skuTaken(
  db: BikriDb,
  sku: string,
  exceptProductId?: string,
): Promise<boolean> {
  const rows = await db.products.where('sku').equals(sku.trim()).toArray();
  return rows.some((p) => !p.deleted_at && p.id !== exceptProductId);
}

/** screens/20: `2` + 11 random digits, unique among local barcodes. */
export async function generateBarcode(
  db: BikriDb,
  random: (n: number) => Uint8Array = (n) =>
    crypto.getRandomValues(new Uint8Array(n)),
): Promise<string> {
  for (;;) {
    const digits = Array.from(random(11), (b) => String(b % 10)).join('');
    const code = `2${digits}`;
    if (!(await barcodeOwner(db, code))) return code;
  }
}

export async function uniqueSku(db: BikriDb, name: string): Promise<string> {
  for (;;) {
    const sku = generateSku(name);
    if (!(await skuTaken(db, sku))) return sku;
  }
}

async function checkCodes(
  db: BikriDb,
  barcodes: string[],
  sku: string,
  exceptId?: string,
): Promise<void> {
  const seen = new Set<string>();
  for (const raw of barcodes) {
    const code = raw.trim();
    if (!code) continue;
    if (seen.has(code)) throw new DuplicateBarcodeError(code, '');
    seen.add(code);
    const owner = await barcodeOwner(db, code, exceptId);
    if (owner) throw new DuplicateBarcodeError(code, String(owner.name_en));
  }
  if (sku.trim() && (await skuTaken(db, sku, exceptId)))
    throw new DuplicateSkuError(sku.trim());
}

export type ProductInput = NewProduct;

/** Ledger context for this till and the current staff member. */
export async function ledgerContext(
  db: BikriDb,
  staffId: string,
): Promise<LedgerContext> {
  const device = await deviceInfo(db);
  const branch = await defaultBranch(db);
  if (!device || !branch)
    throw new Error('This till has no device or branch yet');
  return { branch_id: branch.id, device_id: device.id, staff_id: staffId };
}

function audit(
  w: Writer,
  ctx: LedgerContext,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
) {
  return w.insert('audit_log', {
    id: newId(w.now),
    action,
    entity: 'products',
    entity_id: entityId,
    before_json: before === null ? null : JSON.stringify(before),
    after_json: after === null ? null : JSON.stringify(after),
    device_id: ctx.device_id,
    staff_id: ctx.staff_id,
    created_at: w.now,
  });
}

/** Validates SKU and barcodes, then creates the product (+ barcodes, opening stock) in one action. */
export async function saveNewProduct(
  db: BikriDb,
  input: ProductInput,
  ctx: LedgerContext,
  opts: WriteOptions = {},
): Promise<MasterRow> {
  const sku = input.sku?.trim() || (await uniqueSku(db, input.name_en));
  await checkCodes(db, input.barcodes ?? [], sku);
  return writeAction(db, (w) => createProduct(w, { ...input, sku }, ctx), opts);
}

/**
 * Edits a product (screens/08): barcodes are added/removed as rows; a price change writes
 * `price_change`; a cost change sets `last_cost` only (avg cost history is untouched) and
 * writes `cost_change`.
 */
export async function saveProductEdit(
  db: BikriDb,
  id: string,
  input: ProductInput,
  ctx: LedgerContext,
  opts: WriteOptions = {},
): Promise<MasterRow> {
  const current = await db.products.get(id);
  if (!current || current.deleted_at)
    throw new Error(`Product ${id} not found`);
  const sku = input.sku?.trim() || String(current.sku);
  await checkCodes(db, input.barcodes ?? [], sku, id);
  return writeAction(
    db,
    async (w) => {
      const before = await w.table<MasterRow>('products').get(id);
      if (!before) throw new Error(`Product ${id} not found`);
      const patch: OpRow = {
        name_en: input.name_en.trim(),
        name_ur: input.name_ur?.trim() ?? '',
        brand: input.brand?.trim() ?? '',
        category_id: input.category_id ?? null,
        sku,
        unit: input.unit ?? 'pc',
        price: input.price,
        track_stock: input.track_stock === false ? 0 : 1,
        min_stock_milli: input.min_stock_milli ?? 0,
        warranty_days: input.warranty_days ?? 0,
        notes: input.notes?.trim() ?? '',
      };
      if (input.cost !== undefined) patch.last_cost = input.cost;
      const after = await w.update('products', id, patch);
      if (Number(before.price) !== input.price) {
        await audit(
          w,
          ctx,
          'price_change',
          id,
          { price: before.price },
          { price: input.price },
        );
      }
      if (input.cost !== undefined && Number(before.last_cost) !== input.cost) {
        await audit(
          w,
          ctx,
          'cost_change',
          id,
          { last_cost: before.last_cost },
          { last_cost: input.cost },
        );
      }
      const existing = live(
        await w
          .table<MasterRow>('product_barcodes')
          .where('product_id')
          .equals(id)
          .toArray(),
      );
      const wanted = new Set(
        (input.barcodes ?? []).map((b) => b.trim()).filter(Boolean),
      );
      for (const row of existing) {
        if (!wanted.has(String(row.barcode)))
          await w.remove('product_barcodes', row.id);
        wanted.delete(String(row.barcode));
      }
      for (const code of wanted)
        await w.create('product_barcodes', { product_id: id, barcode: code });
      return after;
    },
    opts,
  );
}

/** True when a not-yet-synced op (other than the product's own rows) points at the product. */
export async function referencedByUnsyncedOp(
  db: BikriDb,
  productId: string,
): Promise<boolean> {
  const pending = await db.outbox.toArray();
  return pending.some(
    (op) =>
      op.tbl !== 'products' &&
      op.tbl !== 'product_barcodes' &&
      op.tbl !== 'audit_log' &&
      !(op.tbl === 'stock_movements' && op.row?.reason_code === 'opening') &&
      op.row?.product_id === productId,
  );
}

/** Soft delete (screens/08): refused while an unsynced op references it; `product_delete` audit. */
export async function removeProduct(
  db: BikriDb,
  id: string,
  ctx: LedgerContext,
  opts: WriteOptions = {},
): Promise<void> {
  if (await referencedByUnsyncedOp(db, id)) throw new ProductInUseError();
  await writeAction(
    db,
    async (w) => {
      const before = await w.table<MasterRow>('products').get(id);
      if (!before || before.deleted_at) return;
      for (const row of live(
        await w
          .table<MasterRow>('product_barcodes')
          .where('product_id')
          .equals(id)
          .toArray(),
      )) {
        await w.remove('product_barcodes', row.id);
      }
      await w.remove('products', id);
      await audit(
        w,
        ctx,
        'product_delete',
        id,
        { name_en: before.name_en, sku: before.sku },
        null,
      );
    },
    opts,
  );
}

/** Form values for `Duplicate`: same details, empty SKU, barcodes, photo and opening stock (AC 7). */
export function duplicateDraft(p: MasterRow): ProductInput {
  return {
    name_en: String(p.name_en),
    name_ur: String(p.name_ur ?? ''),
    brand: String(p.brand ?? ''),
    category_id: (p.category_id as string | null) ?? null,
    sku: '',
    barcodes: [],
    unit: String(p.unit ?? 'pc'),
    price: Number(p.price),
    cost: Number(p.last_cost ?? 0),
    track_stock: p.track_stock === 1,
    min_stock_milli: Number(p.min_stock_milli ?? 0),
    warranty_days: Number(p.warranty_days ?? 0),
    notes: String(p.notes ?? ''),
    opening_milli: 0,
  };
}

// Categories (screens/08 §Categories)

export const CATEGORY_COLORS = [
  't1',
  't2',
  't3',
  't4',
  't5',
  't6',
  't7',
  't8',
] as const;

export async function listCategories(
  db: BikriDb,
): Promise<(MasterRow & { productCount: number })[]> {
  const products = live(await db.products.toArray());
  return live(await db.categories.orderBy('sort_order').toArray()).map((c) => ({
    ...c,
    productCount: products.filter((p) => p.category_id === c.id).length,
  }));
}

export async function addCategory(
  db: BikriDb,
  name: string,
  color = 't1',
  opts: WriteOptions = {},
): Promise<MasterRow> {
  return writeAction(
    db,
    async (w) => {
      const rows = live(await w.table<MasterRow>('categories').toArray());
      const next =
        rows.reduce((m, c) => Math.max(m, Number(c.sort_order ?? 0)), 0) + 1;
      return w.create('categories', {
        name_en: name.trim(),
        name_ur: '',
        color,
        sort_order: next,
      });
    },
    opts,
  );
}

export async function updateCategory(
  db: BikriDb,
  id: string,
  patch: { name_en?: string; color?: string },
  opts: WriteOptions = {},
): Promise<void> {
  const clean: OpRow = {};
  if (patch.name_en !== undefined) clean.name_en = patch.name_en.trim();
  if (patch.color !== undefined) clean.color = patch.color;
  await writeAction(db, (w) => w.update('categories', id, clean), opts);
}

/** Moves a category one place up (-1) or down (+1); rewrites sort_order 1..n where it changed. */
export async function moveCategory(
  db: BikriDb,
  id: string,
  direction: -1 | 1,
  opts: WriteOptions = {},
): Promise<void> {
  await writeAction(
    db,
    async (w) => {
      const rows = live(
        await w.table<MasterRow>('categories').orderBy('sort_order').toArray(),
      );
      const ids = rows.map((r) => r.id);
      const i = ids.indexOf(id);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
      for (const [k, rowId] of ids.entries()) {
        const row = rows.find((r) => r.id === rowId);
        if (row && Number(row.sort_order) !== k + 1)
          await w.update('categories', rowId, { sort_order: k + 1 });
      }
    },
    opts,
  );
}

export async function removeCategory(
  db: BikriDb,
  id: string,
  opts: WriteOptions = {},
): Promise<void> {
  const used = live(
    await db.products.where('category_id').equals(id).toArray(),
  ).length;
  if (used > 0) throw new CategoryInUseError(used);
  await writeAction(db, (w) => w.remove('categories', id), opts);
}

// CSV export (REQ-B02); cost columns only with cost.view (AC 4).

function csvCell(value: unknown): string {
  let s = String(value ?? '');
  // Spreadsheet formula injection: text starting with = + - @ is prefixed with '.
  if (typeof value === 'string' && /^[=+\-@]/u.test(s)) s = `'${s}`;
  return /[",\n\r]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}

const rupees = (paisa: number) =>
  (paisa / 100).toFixed(2).replace(/\.00$/u, '');
const qty = (milli: number) => String(milli / 1000);

export function productsCsv(rows: ProductListRow[], withCost: boolean): string {
  const header = [
    'name_en',
    'name_ur',
    'category',
    'brand',
    'barcode',
    'sku',
    'price',
    ...(withCost ? ['cost', 'avg_cost'] : []),
    'stock',
    'unit',
    'min_stock',
    'track_stock',
    'sold_30_days',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const p = r.product;
    lines.push(
      [
        p.name_en,
        p.name_ur,
        r.category?.name_en ?? '',
        p.brand,
        r.barcodes.join(';'),
        p.sku,
        rupees(Number(p.price)),
        ...(withCost
          ? [rupees(Number(p.last_cost ?? 0)), rupees(Number(p.avg_cost ?? 0))]
          : []),
        qty(r.onHand),
        p.unit,
        qty(Number(p.min_stock_milli ?? 0)),
        p.track_stock === 1 ? 1 : 0,
        qty(r.sold30),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Electronics starter list (screens/04 first run): names only, the owner sets prices. */
export const SUGGESTED_PRODUCTS = [
  'Charger',
  'Cable',
  'Earbuds',
  'Power bank',
  'Screen protector',
  'Back cover',
] as const;
