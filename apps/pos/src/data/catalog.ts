import {
  businessDate,
  generateSku,
  mulDivRound,
  newId,
  type OpRow,
  refundedRevenue,
} from '@bikri/core';
import type { BikriDb, FileQueueEntry, MasterRow, SyncedRow } from '@bikri/db';
import { categoryName } from '../lib/category.ts';
import { csvCell, qtyCsv, rupeesCsv } from '../lib/csv.ts';
import type { SortDirection } from '../lib/sort.ts';
import { type Photo, photoKey } from '../products/photo.ts';
import { putFile } from './fileCache.ts';
import { defaultBranch, deviceInfo } from './localTenant.ts';
import {
  createProduct,
  type LedgerContext,
  type NewProduct,
} from './products.ts';
import { lineRevenue } from './reports.ts';
import {
  type WriteOptions,
  type Writer,
  writeAction,
  writeScope,
} from './write.ts';

const DAY_MS = 86_400_000;
/** Reused for every product sort; creating a collator per comparison is measurably slower. */
const NAME_COLLATOR = new Intl.Collator();

export type StockFilter = 'all' | 'low' | 'out' | 'untracked';
export type ProductSort =
  | 'name'
  | 'category'
  | 'price'
  | 'stock'
  | 'cost'
  | 'margin'
  | 'best';

/** A column's natural first-click order: numbers and names low/A first, best sellers high first. */
export const PRODUCT_SORT_DIRECTIONS: Record<ProductSort, SortDirection> = {
  name: 'asc',
  category: 'asc',
  price: 'asc',
  stock: 'asc',
  cost: 'asc',
  margin: 'asc',
  best: 'desc',
};

export function defaultProductSortDirection(sort: ProductSort): SortDirection {
  return PRODUCT_SORT_DIRECTIONS[sort];
}

export type BundleRecipeRow = {
  product: MasterRow;
  qty_milli: number;
  sort_order: number;
};

/** Derived bundle data; `null` when the product is not a bundle. */
export type BundleInfo = {
  items: BundleRecipeRow[];
  /** Whole bundles that can be made; null when every component is untracked. */
  availability: number | null;
  /** Component cost total for one bundle (shop cost method). */
  cost: number;
  /** Component shelf-price total for one bundle. */
  itemsTotal: number;
  /** The component with the least availability, or null for made-to-order. */
  limiting: BundleRecipeRow | null;
};

export type ProductListRow = {
  product: MasterRow;
  category: MasterRow | null;
  onHand: number;
  sold30: number;
  barcodes: string[];
  stockState: 'ok' | 'low' | 'out' | 'untracked';
  bundle?: BundleInfo;
  /** Lower-cased name/brand/SKU/barcode text, built once for fast filtering. */
  haystack?: string;
};

export function isBundle(product: MasterRow | null | undefined): boolean {
  return product?.kind === 'bundle';
}

/** Cost of one component quantity under the shop's cost method. */
export function componentCost(
  product: MasterRow,
  qtyMilli: number,
  method: 'avg' | 'last',
): number {
  const unit =
    method === 'last'
      ? Number(product.last_cost ?? 0)
      : Number(product.avg_cost ?? 0);
  return mulDivRound(qtyMilli, unit, 1000);
}

/** Active recipe rows of one bundle, oldest position first. */
export async function loadBundleRecipe(
  db: BikriDb,
  bundleId: string,
): Promise<MasterRow[]> {
  return (await db.bundle_items.where('bundle_id').equals(bundleId).toArray())
    .filter((row) => !row.deleted_at)
    .sort(
      (a, b) =>
        Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    );
}

/**
 * Derived recipe, availability and cost. Availability is the smallest whole number of
 * bundles every tracked component can make; untracked components are ignored.
 */
export function bundleInfoOf(
  bundleId: string,
  itemRows: readonly MasterRow[],
  products: ReadonlyMap<string, MasterRow>,
  levels: ReadonlyMap<string, number>,
  method: 'avg' | 'last' = 'avg',
): BundleInfo {
  const items: BundleRecipeRow[] = [];
  for (const row of itemRows) {
    if (row.deleted_at || row.bundle_id !== bundleId) continue;
    const product = products.get(String(row.component_product_id));
    if (!product || product.deleted_at) continue;
    items.push({
      product,
      qty_milli: Number(row.qty_milli),
      sort_order: Number(row.sort_order ?? 0),
    });
  }
  items.sort(
    (a, b) =>
      a.sort_order - b.sort_order || a.product.id.localeCompare(b.product.id),
  );
  let availability: number | null = null;
  let limiting: BundleRecipeRow | null = null;
  let cost = 0;
  let itemsTotal = 0;
  for (const item of items) {
    cost += componentCost(item.product, item.qty_milli, method);
    itemsTotal += mulDivRound(
      item.qty_milli,
      Number(item.product.price ?? 0),
      1000,
    );
    if (item.product.track_stock !== 1) continue;
    const onHand = levels.get(item.product.id) ?? 0;
    const canMake = Math.floor(onHand / item.qty_milli);
    if (availability === null || canMake < availability) {
      availability = canMake;
      limiting = item;
    }
  }
  return { items, availability, cost, itemsTotal, limiting };
}

/** Bundle info for every active bundle, keyed by bundle product id. */
export function buildBundleInfoMap(
  products: readonly MasterRow[],
  itemRows: readonly MasterRow[],
  levels: ReadonlyMap<string, number>,
  method: 'avg' | 'last' = 'avg',
): Map<string, BundleInfo> {
  const byId = new Map(products.map((product) => [product.id, product]));
  const bundleIds = new Set(
    products
      .filter((product) => isBundle(product) && !product.deleted_at)
      .map((product) => product.id),
  );
  const grouped = new Map<string, MasterRow[]>();
  for (const row of itemRows) {
    if (row.deleted_at) continue;
    const id = String(row.bundle_id);
    if (!bundleIds.has(id)) continue;
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  const result = new Map<string, BundleInfo>();
  for (const id of bundleIds)
    result.set(
      id,
      bundleInfoOf(id, grouped.get(id) ?? [], byId, levels, method),
    );
  return result;
}

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

/** A tracked product's cost is owned by deliveries/stock movements, not the form. */
export class TrackedCostError extends Error {
  constructor() {
    super('Tracked product cost can only change through stock movements');
    this.name = 'TrackedCostError';
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
  bundle?: BundleInfo,
): ProductListRow['stockState'] {
  if (isBundle(product)) {
    if (bundle?.availability === null || bundle === undefined)
      return 'untracked';
    return bundle.availability <= 0 ? 'out' : 'ok';
  }
  if (product.track_stock !== 1) return 'untracked';
  if (onHand <= 0) return 'out';
  const min = Number(product.min_stock_milli ?? 0);
  return min > 0 && onHand <= min ? 'low' : 'ok';
}

/**
 * Rows whose `keyOf` is in `ids`.
 *
 * A few hundred index lookups are slower than one table scan in some IndexedDB
 * implementations and every lookup has a round-trip cost; a range scan is also bounded
 * by the 30-day list, not by the shop's lifetime. This is the shape that replaced the
 * old one-query-per-sale N+1: a handful of queries (or one scan), never one per row.
 */
async function rowsForIds<T>(
  table: {
    where(index: string): {
      anyOf(keys: string[]): { toArray(): Promise<T[]> };
    };
  },
  index: string,
  ids: readonly string[],
): Promise<T[]> {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (let at = 0; at < ids.length; at += 100) {
    const chunk = ids.slice(at, at + 100);
    if (chunk.length > 0)
      out.push(...(await table.where(index).anyOf(chunk).toArray()));
  }
  return out;
}

/** Qty sold per product over the last `days` business days, net of refunds. */
export async function soldByProduct(
  db: BikriDb,
  days: number,
  now = Date.now(),
  timeZone = 'Asia/Karachi',
): Promise<Map<string, number>> {
  const from = businessDate(now - (days - 1) * DAY_MS, timeZone);
  const to = businessDate(now, timeZone);
  const sold = new Map<string, number>();
  const sales = await db.sales
    .where('business_date')
    .between(from, to, true, true)
    .toArray();
  const liveSales = sales.filter((sale) => sale.status !== 'void');
  const saleIds = new Set(liveSales.map((sale) => String(sale.id)));
  // The line's own business date (D-228) bounds this to the 30-day window. The old
  // sale-id list crossed 100 keys on a busy day and scanned every line ever written.
  // A bundle group contributes its bundle_qty (not one per group); its components are
  // also real product sales.
  const bundleGroups = new Set<string>();
  for (const line of await db.sale_lines
    .where('business_date')
    .between(from, to, true, true)
    .toArray()) {
    if (!saleIds.has(String(line.sale_id))) continue;
    if (line.bundle_id && line.bundle_group) {
      const key = `${String(line.sale_id)}|${String(line.bundle_group)}`;
      if (!bundleGroups.has(key)) {
        bundleGroups.add(key);
        const bundleQty = Number(line.bundle_qty);
        const bundles =
          Number.isSafeInteger(bundleQty) && bundleQty > 0 ? bundleQty : 1;
        // Sold quantities are milli-units everywhere; one bundle = 1000.
        const bundleId = String(line.bundle_id);
        sold.set(bundleId, (sold.get(bundleId) ?? 0) + bundles * 1000);
      }
    }
    if (!line.product_id) continue;
    const id = String(line.product_id);
    sold.set(id, (sold.get(id) ?? 0) + Number(line.qty_milli));
  }
  // Refunds count on their own business date (07 §9), including refunds of older bills.
  // The refund's date is denormalised onto its lines (Dexie V10), so the window is one
  // date-index range instead of a refund-id list that flipped to a full table scan.
  const refundLines = await db.refund_lines
    .where('business_date')
    .between(from, to, true, true)
    .toArray();
  if (refundLines.length > 0) {
    const saleLines = new Map(
      (
        await db.sale_lines.bulkGet(
          refundLines.map((line) => String(line.sale_line_id)),
        )
      )
        .filter((line): line is SyncedRow => line !== undefined)
        .map((line) => [String(line.id), line]),
    );
    const refundedBundleGroups = new Set<string>();
    for (const line of refundLines) {
      const saleLine = saleLines.get(String(line.sale_line_id));
      if (!saleLine) continue;
      // A bundle refund has one line per component; subtract the returned whole
      // bundles once per refund group, not once per component line.
      if (saleLine.bundle_id && saleLine.bundle_group) {
        const groupKey = `${String(line.refund_id)}|${String(saleLine.bundle_group)}`;
        if (!refundedBundleGroups.has(groupKey)) {
          refundedBundleGroups.add(groupKey);
          const perBundle = Number(saleLine.bundle_component_qty_milli);
          const qty = Number(line.qty_milli);
          const bundles =
            perBundle > 0 &&
            Number.isSafeInteger(qty) &&
            qty > 0 &&
            qty % perBundle === 0
              ? qty / perBundle
              : 0;
          if (bundles > 0) {
            const bundleId = String(saleLine.bundle_id);
            sold.set(bundleId, (sold.get(bundleId) ?? 0) - bundles * 1000);
          }
        }
      }
      if (!saleLine.product_id) continue;
      const id = String(saleLine.product_id);
      sold.set(id, (sold.get(id) ?? 0) - Number(line.qty_milli));
    }
  }
  return sold;
}

/** Every word must appear in the name (either language), brand, SKU or a barcode (screens/08). */
export function matchesQuery(row: ProductListRow, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const p = row.product;
  const haystack =
    row.haystack ??
    [p.name_en, p.name_ur, p.brand, p.sku, ...row.barcodes]
      .map((v) => String(v ?? '').toLowerCase())
      .join(' ');
  return words.every((w) => haystack.includes(w));
}

export function filterAndSortProducts(
  input: readonly ProductListRow[],
  opts: {
    query?: string;
    categoryId?: string | null;
    stock?: StockFilter;
    sort?: ProductSort;
    direction?: SortDirection;
    language?: string;
    kind?: 'simple' | 'bundle';
  } = {},
): ProductListRow[] {
  let rows = input.slice();
  if (opts.kind) rows = rows.filter((r) => r.product.kind === opts.kind);
  if (opts.query) rows = rows.filter((r) => matchesQuery(r, opts.query ?? ''));
  if (opts.categoryId)
    rows = rows.filter((r) => r.product.category_id === opts.categoryId);
  const stock = opts.stock ?? 'all';
  if (stock === 'low') rows = rows.filter((r) => r.stockState === 'low');
  if (stock === 'out') rows = rows.filter((r) => r.stockState === 'out');
  if (stock === 'untracked')
    rows = rows.filter((r) => r.stockState === 'untracked');
  const byName = (a: ProductListRow, b: ProductListRow) =>
    NAME_COLLATOR.compare(String(a.product.name_en), String(b.product.name_en));
  const sort = opts.sort ?? 'name';
  const sign =
    (opts.direction ?? defaultProductSortDirection(sort)) === 'asc' ? 1 : -1;
  const rowCost = (row: ProductListRow): number =>
    row.bundle ? row.bundle.cost : Number(row.product.avg_cost ?? 0);
  const margin = (row: ProductListRow): number | null => {
    const price = Number(row.product.price);
    if (!(price > 0)) return null;
    return (price - rowCost(row)) / price;
  };
  rows.sort((a, b) => {
    if (sort === 'category') {
      const aName = categoryName(a.category, opts.language ?? 'en');
      const bName = categoryName(b.category, opts.language ?? 'en');
      if (!aName && !bName) return byName(a, b);
      if (!aName) return 1;
      if (!bName) return -1;
      return sign * NAME_COLLATOR.compare(aName, bName) || byName(a, b);
    }
    if (sort === 'price')
      return (
        sign * (Number(a.product.price) - Number(b.product.price)) ||
        byName(a, b)
      );
    if (sort === 'stock') return sign * (a.onHand - b.onHand) || byName(a, b);
    if (sort === 'cost')
      return sign * (rowCost(a) - rowCost(b)) || byName(a, b);
    if (sort === 'margin') {
      const aMargin = margin(a);
      const bMargin = margin(b);
      if (aMargin === null && bMargin === null) return byName(a, b);
      if (aMargin === null) return 1;
      if (bMargin === null) return -1;
      return sign * (aMargin - bMargin) || byName(a, b);
    }
    if (sort === 'best') return sign * (a.sold30 - b.sold30) || byName(a, b);
    return sign * byName(a, b);
  });
  return rows;
}

export async function listProducts(
  db: BikriDb,
  opts: {
    query?: string;
    categoryId?: string | null;
    stock?: StockFilter;
    sort?: ProductSort;
    direction?: SortDirection;
    language?: string;
    now?: number;
    timeZone?: string;
    costMethod?: 'avg' | 'last';
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
  const bundles = buildBundleInfoMap(
    products,
    await db.bundle_items.toArray(),
    levels,
    opts.costMethod ?? 'avg',
  );
  const sold = await soldByProduct(db, 30, opts.now, opts.timeZone);
  const rows: ProductListRow[] = products.map((product) => {
    const bundle = bundles.get(product.id);
    const onHand = bundle
      ? (bundle.availability ?? 0) * 1000
      : (levels.get(product.id) ?? 0);
    return {
      product,
      category: categories.get(String(product.category_id)) ?? null,
      onHand,
      sold30: sold.get(product.id) ?? 0,
      barcodes: barcodes.get(product.id) ?? [],
      stockState: stockStateOf(product, onHand, bundle),
      ...(bundle ? { bundle } : {}),
    };
  });
  return filterAndSortProducts(rows, opts);
}

export type MovementHistoryRow = {
  kind: 'movement';
  movement: SyncedRow;
  balanceAfter: number;
  staffName: string;
};

/** A tracking switch change has no quantity; its balance is the on-hand at that moment. */
export type TrackingHistoryRow = {
  kind: 'tracking';
  audit: SyncedRow;
  trackStock: 0 | 1;
  minStockBefore: number | null;
  minStockAfter: number | null;
  balanceAfter: number;
  staffName: string;
};

export type HistoryRow = MovementHistoryRow | TrackingHistoryRow;

/** Stock-history rows shown before "Show older"; CSV export still reads them all. */
export const PRODUCT_HISTORY_PAGE = 200;

export type ProductDetail = {
  product: MasterRow;
  category: MasterRow | null;
  barcodes: MasterRow[];
  onHand: number;
  history: HistoryRow[];
  /** True when older movements exist beyond the requested page. */
  hasMoreHistory: boolean;
  /** Oldest first: 14 business days of qty sold (bundles for a bundle product). */
  last14: { date: string; qty: number; revenue: number }[];
  /** Recipe, availability and derived cost; null for a simple product. */
  bundle: BundleInfo | null;
};

function parsedHistoryJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function trackingHistoryRow(audit: SyncedRow): TrackingHistoryRow {
  const before = parsedHistoryJson(audit.before_json);
  const after = parsedHistoryJson(audit.after_json);
  return {
    kind: 'tracking',
    audit,
    trackStock: Number(after?.track_stock) === 1 ? 1 : 0,
    minStockBefore:
      before !== null && 'min_stock_milli' in before
        ? Number(before.min_stock_milli)
        : null,
    minStockAfter:
      after !== null && 'min_stock_milli' in after
        ? Number(after.min_stock_milli)
        : null,
    balanceAfter: 0,
    staffName: '',
  };
}

function historyAt(row: HistoryRow): number {
  return Number(
    row.kind === 'movement' ? row.movement.created_at : row.audit.created_at,
  );
}

function historyId(row: HistoryRow): string {
  return String(row.kind === 'movement' ? row.movement.id : row.audit.id);
}

async function loadHistory(
  db: BikriDb,
  id: string,
  limit: number,
): Promise<{ rows: HistoryRow[]; hasMore: boolean }> {
  const page = Number.isFinite(limit);
  const wanted = page
    ? Math.max(1, Math.floor(limit))
    : Number.POSITIVE_INFINITY;
  const base = db.stock_movements
    .where('[product_id+created_at]')
    .between([id, 0], [id, Infinity]);
  const movements = page
    ? await base
        .reverse()
        .limit(wanted + 1)
        .toArray()
    : await base.reverse().toArray();
  const hasMore = page && movements.length > wanted;
  const shownMovements = hasMore ? movements.slice(0, wanted) : movements;
  const oldestShown = shownMovements.at(-1);
  const audits = (
    await db.audit_log
      .where('[entity+entity_id]')
      .equals(['products', id])
      .toArray()
  ).filter((audit) => audit.action === 'track_stock_change');
  // A page of movements must not jump over a tracking change and show an old one
  // next to newer movements; the event appears when "Show older" reaches it.
  const shownAudits =
    hasMore && oldestShown
      ? audits.filter(
          (audit) => Number(audit.created_at) >= Number(oldestShown.created_at),
        )
      : audits;
  const staff = new Map(
    (await db.staff.toArray()).map((s) => [s.id, String(s.name ?? '')]),
  );
  const rows = [
    ...shownMovements.map(
      (movement): HistoryRow => ({
        kind: 'movement',
        movement,
        balanceAfter: 0,
        staffName: staff.get(String(movement.staff_id)) ?? '',
      }),
    ),
    ...shownAudits.map((audit): HistoryRow => {
      const row = trackingHistoryRow(audit);
      row.staffName = staff.get(String(audit.staff_id)) ?? '';
      return row;
    }),
  ].sort(
    (a, b) =>
      historyAt(b) - historyAt(a) || historyId(b).localeCompare(historyId(a)),
  );
  let running = (await db.stock_levels.get(id))?.on_hand_milli ?? 0;
  for (const row of rows) {
    row.balanceAfter = running;
    if (row.kind === 'movement')
      running -= Number(row.movement.qty_delta_milli);
  }
  return { rows, hasMore };
}

/**
 * One product's movements and tracking changes, newest first, with the running balance
 * after each. A product can accumulate thousands of movements; the screen pages them via
 * `productStockHistoryPage`. `productStockHistory(db, id)` with no limit returns everything
 * for the CSV export.
 */
export async function productStockHistory(
  db: BikriDb,
  id: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<HistoryRow[]> {
  return (await loadHistory(db, id, limit)).rows;
}

/** The screen's page: `limit` movements plus the tracking changes that fall in that window. */
export async function productStockHistoryPage(
  db: BikriDb,
  id: string,
  limit: number,
): Promise<{ rows: HistoryRow[]; hasMore: boolean }> {
  return loadHistory(db, id, limit);
}

export async function productDetail(
  db: BikriDb,
  id: string,
  now = Date.now(),
  historyLimit = PRODUCT_HISTORY_PAGE,
  costMethod: 'avg' | 'last' = 'avg',
  timeZone = 'Asia/Karachi',
): Promise<ProductDetail | null> {
  const product = await db.products.get(id);
  if (!product || product.deleted_at) return null;
  const category = product.category_id
    ? ((await db.categories.get(String(product.category_id))) ?? null)
    : null;
  const barcodes = live(
    await db.product_barcodes.where('product_id').equals(id).toArray(),
  );
  const bundle = isBundle(product)
    ? await (async () => {
        const items = await loadBundleRecipe(db, id);
        const products = new Map(
          (
            await db.products.bulkGet(
              items.map((row) => String(row.component_product_id)),
            )
          )
            .filter((row): row is MasterRow => row !== undefined)
            .map((row) => [row.id, row]),
        );
        const levels = new Map(
          (await db.stock_levels.toArray()).map((level) => [
            level.product_id,
            level.on_hand_milli,
          ]),
        );
        return bundleInfoOf(id, items, products, levels, costMethod);
      })()
    : null;
  // Read one extra movement to know whether "Show older" is needed, without a
  // second index count over a long history.
  const historyPage = bundle
    ? { rows: [], hasMore: false }
    : await productStockHistoryPage(db, id, historyLimit);
  const days: ProductDetail['last14'] = [];
  for (let i = 13; i >= 0; i -= 1)
    days.push({
      date: businessDate(now - i * DAY_MS, timeZone),
      qty: 0,
      revenue: 0,
    });
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  const first = days[0]?.date ?? '';
  const last = days[13]?.date ?? '';
  const sales = await db.sales
    .where('business_date')
    .between(first, last, true, true)
    .toArray();
  const byId = new Map(
    sales.filter((s) => s.status !== 'void').map((s) => [s.id, s]),
  );
  // The product index is selective (one product, not the shop's whole line table); the
  // sale map then keeps only the 14-day window. Loading every sale line by sale id
  // would make one round trip per chunk on a busy shop.
  const productLines: { line: SyncedRow; sale: SyncedRow }[] = [];
  for (const line of await db.sale_lines
    .where('[product_id+business_date]')
    .between([id, first], [id, last], true, true)
    .toArray()) {
    const sale = byId.get(String(line.sale_id));
    if (!sale) continue;
    productLines.push({ line, sale });
    const day = dayByDate.get(String(sale.business_date));
    if (!day) continue;
    day.qty += Number(line.qty_milli);
    // Each sale keeps its own tax-inclusive snapshot; using the shop's current mode
    // would rewrite history after a tax setting change.
    day.revenue += lineRevenue(line, sale.tax_inclusive === 1);
  }
  // Refunds count on the date they happen, including a refund today of a sale older
  // than the 14-day chart window (07 §9). Load the refunds in the window first, then
  // their original sale lines and every earlier refund of those lines for the
  // cumulative per-line allocation.
  const windowRefundLines = await db.refund_lines
    .where('business_date')
    .between(first, last, true, true)
    .toArray();
  const refundOriginalLines =
    windowRefundLines.length === 0
      ? new Map<string, SyncedRow>()
      : new Map(
          (
            await db.sale_lines.bulkGet(
              windowRefundLines.map((line) => String(line.sale_line_id)),
            )
          )
            .filter((line): line is SyncedRow => line !== undefined)
            .map((line) => [String(line.id), line]),
        );
  const saleCache = new Map(byId);
  const saleFor = async (saleId: string): Promise<SyncedRow | undefined> => {
    const known = saleCache.get(saleId);
    if (known) return known;
    const sale = await db.sales.get(saleId);
    if (sale) saleCache.set(saleId, sale);
    return sale;
  };
  const simpleRefundLines = [...refundOriginalLines.values()].filter(
    (line) => line.product_id === id,
  );
  if (simpleRefundLines.length > 0) {
    const allRefundLines = await rowsForIds<SyncedRow>(
      db.refund_lines,
      'sale_line_id',
      simpleRefundLines.map((line) => String(line.id)),
    );
    const allRefunds = new Map(
      (
        await db.refunds.bulkGet([
          ...new Set(allRefundLines.map((line) => String(line.refund_id))),
        ])
      )
        .filter((refund): refund is SyncedRow => refund !== undefined)
        .map((refund) => [String(refund.id), refund]),
    );
    const bySaleLine = new Map<string, SyncedRow[]>();
    for (const refundLine of allRefundLines) {
      const key = String(refundLine.sale_line_id);
      const list = bySaleLine.get(key) ?? [];
      list.push(refundLine);
      bySaleLine.set(key, list);
    }
    for (const line of simpleRefundLines) {
      const sale = await saleFor(String(line.sale_id));
      if (!sale) continue;
      const forLine = (bySaleLine.get(String(line.id)) ?? []).sort(
        (a, b) =>
          Number(a.created_at) - Number(b.created_at) ||
          String(a.id).localeCompare(String(b.id)),
      );
      let previous = 0;
      for (const refundLine of forLine) {
        const refund = allRefunds.get(String(refundLine.refund_id));
        const qty = Number(refundLine.qty_milli);
        const day = refund
          ? dayByDate.get(String(refund.business_date))
          : undefined;
        if (refund && day) {
          day.qty -= qty;
          day.revenue -= refundedRevenue(
            lineRevenue(line, sale.tax_inclusive === 1),
            Number(line.qty_milli),
            previous,
            qty,
          );
        }
        previous += qty;
      }
    }
  }
  if (bundle) {
    for (const day of days) {
      day.qty = 0;
      day.revenue = 0;
    }
    // Sale day: one bundle quantity per group, component revenue per line.
    const seenSaleGroups = new Set<string>();
    const bundleLines = (
      await db.sale_lines.where('bundle_id').equals(id).toArray()
    ).filter(
      (line) =>
        String(line.business_date) >= first &&
        String(line.business_date) <= last &&
        line.bundle_group !== undefined,
    );
    for (const line of bundleLines) {
      const sale = byId.get(String(line.sale_id));
      if (!sale) continue;
      const day = dayByDate.get(String(sale.business_date));
      if (!day) continue;
      const key = `${String(line.sale_id)}|${String(line.bundle_group)}`;
      if (!seenSaleGroups.has(key)) {
        seenSaleGroups.add(key);
        const bundleQty = Number(line.bundle_qty);
        const bundles =
          Number.isSafeInteger(bundleQty) && bundleQty > 0 ? bundleQty : 1;
        day.qty += bundles * 1000;
      }
      day.revenue += lineRevenue(line, sale.tax_inclusive === 1);
    }
    // Refunds in the window, including refunds of sales older than the chart window.
    const bundleRefundLines = [...refundOriginalLines.values()].filter(
      (line) => line.bundle_id === id && line.bundle_group,
    );
    if (bundleRefundLines.length > 0) {
      const allRefundLines = await rowsForIds<SyncedRow>(
        db.refund_lines,
        'sale_line_id',
        bundleRefundLines.map((line) => String(line.id)),
      );
      const allRefunds = new Map(
        (
          await db.refunds.bulkGet([
            ...new Set(allRefundLines.map((line) => String(line.refund_id))),
          ])
        )
          .filter((refund): refund is SyncedRow => refund !== undefined)
          .map((refund) => [String(refund.id), refund]),
      );
      // Quantity: subtract the returned whole bundles once per refund group.
      const refundedGroups = new Set<string>();
      for (const refundLine of allRefundLines) {
        const original = refundOriginalLines.get(
          String(refundLine.sale_line_id),
        );
        const refund = allRefunds.get(String(refundLine.refund_id));
        if (!original || !refund) continue;
        const day = dayByDate.get(String(refund.business_date));
        if (!day) continue;
        const groupKey = `${String(refund.id)}|${String(original.bundle_group)}`;
        if (refundedGroups.has(groupKey)) continue;
        refundedGroups.add(groupKey);
        const perBundle = Number(original.bundle_component_qty_milli);
        const qty = Number(refundLine.qty_milli);
        if (perBundle > 0 && qty > 0 && qty % perBundle === 0)
          day.qty -= (qty / perBundle) * 1000;
      }
      // Revenue: the cumulative ex-tax share of each component line, on the refund's
      // own business date.
      const byLine = new Map<string, SyncedRow[]>();
      for (const refundLine of allRefundLines) {
        const key = String(refundLine.sale_line_id);
        byLine.set(key, [...(byLine.get(key) ?? []), refundLine]);
      }
      for (const [lineId, refundsForLine] of byLine) {
        const original = refundOriginalLines.get(lineId);
        if (!original) continue;
        const sale = await saleFor(String(original.sale_id));
        if (!sale) continue;
        const sorted = [...refundsForLine].sort(
          (a, b) =>
            Number(a.created_at) - Number(b.created_at) ||
            String(a.id).localeCompare(String(b.id)),
        );
        let previous = 0;
        for (const refundLine of sorted) {
          const refund = allRefunds.get(String(refundLine.refund_id));
          const qty = Number(refundLine.qty_milli);
          const day = refund
            ? dayByDate.get(String(refund.business_date))
            : undefined;
          if (refund && day) {
            day.revenue -= refundedRevenue(
              lineRevenue(original, sale.tax_inclusive === 1),
              Number(original.qty_milli),
              previous,
              qty,
            );
          }
          previous += qty;
        }
      }
    }
  }
  return {
    product,
    category,
    barcodes,
    onHand: (await db.stock_levels.get(id))?.on_hand_milli ?? 0,
    history: historyPage.rows,
    hasMoreHistory: historyPage.hasMore,
    last14: days,
    bundle,
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

export type BundleItemInput = {
  component_product_id: string;
  qty_milli: number;
};

export type ProductInput = NewProduct & {
  /** New photo to store; `null` removes the photo on edit; `undefined` keeps it. */
  photo?: Photo | null;
  /** Fixed recipe when `kind='bundle'`. */
  bundle_items?: BundleItemInput[];
};

export type NormalBundleItem = BundleItemInput & { sort_order: number };

/** Merges duplicates and enforces the 1–20 simple-component recipe rules (02 §2.16). */
export async function normaliseBundleItems(
  db: BikriDb,
  bundleId: string,
  items: readonly BundleItemInput[],
): Promise<{ items: NormalBundleItem[]; products: Map<string, MasterRow> }> {
  const merged = new Map<string, number>();
  for (const item of items) {
    const id = item.component_product_id;
    if (!id || id === bundleId) throw new BundleRecipeError('component');
    if (!Number.isSafeInteger(item.qty_milli) || item.qty_milli <= 0)
      throw new BundleRecipeError('qty');
    merged.set(id, (merged.get(id) ?? 0) + item.qty_milli);
  }
  if (merged.size < 1 || merged.size > 20) throw new BundleRecipeError('count');
  const products = new Map<string, MasterRow>();
  for (const id of merged.keys()) {
    const product = await db.products.get(id);
    if (!product || product.deleted_at || product.kind === 'bundle')
      throw new BundleRecipeError('component');
    products.set(id, product);
  }
  return {
    items: [...merged.entries()].map(
      ([component_product_id, qty_milli], i) => ({
        component_product_id,
        qty_milli,
        sort_order: i,
      }),
    ),
    products,
  };
}

export class BundleRecipeError extends Error {
  readonly code: 'component' | 'qty' | 'count';
  constructor(code: BundleRecipeError['code']) {
    super(code);
    this.name = 'BundleRecipeError';
    this.code = code;
  }
}

export class ComponentInUseError extends Error {
  readonly bundleName: string;
  constructor(bundleName: string) {
    super(`Component is used by ${bundleName}`);
    this.name = 'ComponentInUseError';
    this.bundleName = bundleName;
  }
}

async function bundleUsingComponent(
  db: BikriDb,
  productId: string,
): Promise<MasterRow | null> {
  const rows = (
    await db.bundle_items
      .where('component_product_id')
      .equals(productId)
      .toArray()
  ).filter((row) => !row.deleted_at);
  for (const row of rows) {
    const bundle = await db.products.get(String(row.bundle_id));
    if (bundle && !bundle.deleted_at && bundle.kind === 'bundle') return bundle;
  }
  return null;
}

/** Replaces the recipe in the caller's action; removes rows by soft delete. */
async function syncBundleItems(
  w: Writer,
  bundleId: string,
  items: readonly NormalBundleItem[],
  ctx: LedgerContext,
): Promise<void> {
  const table = w.table<MasterRow, string>('bundle_items');
  const existing = (
    await table.where('bundle_id').equals(bundleId).toArray()
  ).filter((row) => !row.deleted_at);
  const wanted = new Map(
    items.map((item) => [item.component_product_id, item]),
  );
  for (const row of existing) {
    const next = wanted.get(String(row.component_product_id));
    if (!next) {
      await w.remove('bundle_items', row.id);
      continue;
    }
    if (
      Number(row.qty_milli) !== next.qty_milli ||
      Number(row.sort_order ?? 0) !== next.sort_order
    )
      await w.update('bundle_items', row.id, {
        qty_milli: next.qty_milli,
        sort_order: next.sort_order,
        updated_by: ctx.staff_id,
      });
    wanted.delete(String(row.component_product_id));
  }
  for (const item of wanted.values())
    await w.create('bundle_items', {
      bundle_id: bundleId,
      component_product_id: item.component_product_id,
      qty_milli: item.qty_milli,
      sort_order: item.sort_order,
      updated_by: ctx.staff_id,
    });
}

async function queuePhoto(
  w: Writer,
  productId: string,
  photo: Photo,
  staffId: string,
): Promise<void> {
  await w.table<FileQueueEntry, number>('file_queue').add({
    kind: 'product_image',
    target_id: productId,
    blob: photo.blob,
    sha256: photo.sha256,
    staff_id: staffId,
    status: 'pending',
    created_at: Date.now(),
  });
}

/** Ledger context for this till and the current staff member. */
export async function ledgerContext(
  db: BikriDb,
  staffId: string,
): Promise<LedgerContext> {
  const device = await deviceInfo(db);
  const branch =
    (device?.branch_id ? await db.branches.get(device.branch_id) : undefined) ??
    (await defaultBranch(db));
  if (!device || !branch)
    throw new Error('This till has no device or branch yet');
  return { branch_id: branch.id, device_id: device.id, staff_id: staffId };
}

export function productAudit(
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
  const { photo, bundle_items: bundleItems, ...rest } = input;
  const isBundle = input.kind === 'bundle';
  const id = input.id ?? newId(opts.now);
  const recipe = isBundle
    ? await normaliseBundleItems(db, id, bundleItems ?? [])
    : null;
  const imageKey = photo ? photoKey(id, photo) : null;
  // Cache first, so the thumbnail can render as soon as the row appears.
  if (photo && imageKey) await putFile(db.tenantId, imageKey, photo.blob);
  const product = await writeAction(
    db,
    async (w) => {
      const created = await createProduct(
        w,
        {
          ...rest,
          id,
          sku,
          image_key: imageKey,
          kind: isBundle ? 'bundle' : 'simple',
        },
        ctx,
      );
      if (photo) await queuePhoto(w, id, photo, ctx.staff_id);
      if (recipe) {
        await syncBundleItems(w, id, recipe.items, ctx);
        await productAudit(w, ctx, 'bundle_change', id, null, {
          items: recipe.items,
        });
      }
      return created;
    },
    {
      actor: ctx.staff_id,
      ...opts,
      tables: isBundle
        ? writeScope(
            'products',
            'bundle_items',
            'product_barcodes',
            'audit_log',
            'stock_movements',
            'stock_levels',
            'file_queue',
          )
        : writeScope(
            'products',
            'product_barcodes',
            'stock_movements',
            'stock_levels',
            'file_queue',
          ),
    },
  );
  return product;
}

/**
 * Edits a product (screens/08): barcodes are added/removed as rows; a price change writes
 * `price_change`; a cost change sets `last_cost` only (avg cost history is untouched) and
 * writes `cost_change`; turning tracking on/off writes `track_stock_change` (with the
 * cleared low-stock alert when it changes).
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
  const isBundle = input.kind === 'bundle' || current.kind === 'bundle';
  if (current.kind === 'bundle' && input.kind === 'simple')
    throw new BundleRecipeError('component');
  if (current.kind !== 'bundle' && input.kind === 'bundle') {
    const bundle = await bundleUsingComponent(db, id);
    if (bundle)
      throw new ComponentInUseError(String(bundle.name_en ?? 'a bundle'));
  }
  const sku = input.sku?.trim() || String(current.sku);
  await checkCodes(db, input.barcodes ?? [], sku, id);
  if (input.photo)
    await putFile(db.tenantId, photoKey(id, input.photo), input.photo.blob);
  const recipe =
    isBundle && input.bundle_items !== undefined
      ? await normaliseBundleItems(db, id, input.bundle_items)
      : null;
  return writeAction(
    db,
    async (w) => {
      const before = await w.table<MasterRow>('products').get(id);
      if (!before) throw new Error(`Product ${id} not found`);
      const stillTracked =
        !isBundle &&
        input.track_stock !== false &&
        Number(before.track_stock) === 1;
      if (
        stillTracked &&
        input.cost !== undefined &&
        input.cost !== Number(before.last_cost)
      )
        throw new TrackedCostError();
      const patch: OpRow = {
        name_en: input.name_en.trim(),
        name_ur: input.name_ur?.trim() ?? '',
        brand: input.brand?.trim() ?? '',
        category_id: input.category_id ?? null,
        sku,
        unit: input.unit ?? 'pc',
        price: input.price,
        track_stock: isBundle || input.track_stock === false ? 0 : 1,
        min_stock_milli: isBundle ? 0 : (input.min_stock_milli ?? 0),
        warranty_days: isBundle ? 0 : (input.warranty_days ?? 0),
        notes: input.notes?.trim() ?? '',
        kind: isBundle ? 'bundle' : 'simple',
      };
      if (!isBundle && input.cost !== undefined) patch.last_cost = input.cost;
      if (isBundle) patch.last_cost = 0;
      if (input.photo === null) patch.image_key = null;
      if (input.photo) {
        patch.image_key = photoKey(id, input.photo);
        await queuePhoto(w, id, input.photo, ctx.staff_id);
      }
      const beforeRecipe = isBundle
        ? live(
            await w
              .table<MasterRow, string>('bundle_items')
              .where('bundle_id')
              .equals(id)
              .toArray(),
          )
            .map((row) => ({
              component_product_id: String(row.component_product_id),
              qty_milli: Number(row.qty_milli),
              sort_order: Number(row.sort_order ?? 0),
            }))
            .sort(
              (a, b) =>
                a.sort_order - b.sort_order ||
                a.component_product_id.localeCompare(b.component_product_id),
            )
        : [];
      const after = await w.update('products', id, patch);
      if (Number(before.price) !== input.price) {
        await productAudit(
          w,
          ctx,
          'price_change',
          id,
          { price: before.price },
          { price: input.price },
        );
      }
      if (
        !isBundle &&
        input.cost !== undefined &&
        Number(before.last_cost) !== input.cost
      ) {
        await productAudit(
          w,
          ctx,
          'cost_change',
          id,
          { last_cost: before.last_cost },
          { last_cost: input.cost },
        );
      }
      if (recipe) {
        await syncBundleItems(w, id, recipe.items, ctx);
        if (JSON.stringify(beforeRecipe) !== JSON.stringify(recipe.items)) {
          await productAudit(
            w,
            ctx,
            'bundle_change',
            id,
            {
              items: beforeRecipe,
            },
            { items: recipe.items },
          );
        }
      }
      const beforeTrack = Number(before.track_stock) === 1 ? 1 : 0;
      const afterTrack = Number(patch.track_stock) === 1 ? 1 : 0;
      if (!isBundle && beforeTrack !== afterTrack) {
        const minBefore = Number(before.min_stock_milli ?? 0);
        const minAfter = Number(patch.min_stock_milli ?? 0);
        const auditBefore: Record<string, number> = {
          track_stock: beforeTrack,
        };
        const auditAfter: Record<string, number> = { track_stock: afterTrack };
        if (minBefore !== minAfter) {
          auditBefore.min_stock_milli = minBefore;
          auditAfter.min_stock_milli = minAfter;
        }
        await productAudit(
          w,
          ctx,
          'track_stock_change',
          id,
          auditBefore,
          auditAfter,
        );
      }
      if (input.barcodes !== undefined) {
        const existing = live(
          await w
            .table<MasterRow>('product_barcodes')
            .where('product_id')
            .equals(id)
            .toArray(),
        );
        const wanted = new Set(
          input.barcodes.map((b) => b.trim()).filter(Boolean),
        );
        for (const row of existing) {
          if (!wanted.has(String(row.barcode)))
            await w.remove('product_barcodes', row.id);
          wanted.delete(String(row.barcode));
        }
        for (const code of wanted)
          await w.create('product_barcodes', { product_id: id, barcode: code });
      }
      return after;
    },
    {
      actor: ctx.staff_id,
      ...opts,
      tables: isBundle
        ? writeScope(
            'products',
            'bundle_items',
            'product_barcodes',
            'audit_log',
            'file_queue',
          )
        : writeScope('products', 'product_barcodes', 'audit_log', 'file_queue'),
    },
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
  const usedBy = await bundleUsingComponent(db, id);
  if (usedBy)
    throw new ComponentInUseError(String(usedBy.name_en ?? 'a bundle'));
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
      await productAudit(
        w,
        ctx,
        'product_delete',
        id,
        { name_en: before.name_en, sku: before.sku },
        null,
      );
    },
    {
      actor: ctx.staff_id,
      ...opts,
      tables: writeScope('products', 'product_barcodes', 'audit_log'),
    },
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
    cost: p.kind === 'bundle' ? 0 : Number(p.last_cost ?? 0),
    track_stock: p.kind === 'bundle' ? false : p.track_stock === 1,
    min_stock_milli: p.kind === 'bundle' ? 0 : Number(p.min_stock_milli ?? 0),
    warranty_days: p.kind === 'bundle' ? 0 : Number(p.warranty_days ?? 0),
    notes: String(p.notes ?? ''),
    opening_milli: 0,
    kind: p.kind === 'bundle' ? 'bundle' : 'simple',
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
  const counts = new Map<string, number>();
  for (const product of live(await db.products.toArray())) {
    const id = product.category_id ? String(product.category_id) : '';
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return live(await db.categories.orderBy('sort_order').toArray()).map((c) => ({
    ...c,
    productCount: counts.get(c.id) ?? 0,
  }));
}

export async function addCategory(
  db: BikriDb,
  name: string,
  color = 't1',
  opts: WriteOptions = {},
  nameUr = '',
): Promise<MasterRow> {
  return writeAction(
    db,
    async (w) => {
      const rows = live(await w.table<MasterRow>('categories').toArray());
      const next =
        rows.reduce((m, c) => Math.max(m, Number(c.sort_order ?? 0)), 0) + 1;
      return w.create('categories', {
        name_en: name.trim().slice(0, 40),
        name_ur: nameUr.trim().slice(0, 40),
        color,
        sort_order: next,
      });
    },
    { ...opts, tables: writeScope('categories') },
  );
}

export async function updateCategory(
  db: BikriDb,
  id: string,
  patch: { name_en?: string; name_ur?: string; color?: string },
  opts: WriteOptions = {},
): Promise<void> {
  const clean: OpRow = {};
  if (patch.name_en !== undefined)
    clean.name_en = patch.name_en.trim().slice(0, 40);
  if (patch.name_ur !== undefined)
    clean.name_ur = patch.name_ur.trim().slice(0, 40);
  if (patch.color !== undefined) clean.color = patch.color;
  await writeAction(db, (w) => w.update('categories', id, clean), {
    ...opts,
    tables: writeScope('categories'),
  });
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
      const i = rows.findIndex((row) => row.id === id);
      const j = i + direction;
      const a = rows[i];
      const b = rows[j];
      if (!a || !b) return;
      // Swap only the two positions; normalising the whole list would exceed the
      // 200-op action limit on a large catalogue.
      await w.update('categories', a.id, { sort_order: Number(b.sort_order) });
      await w.update('categories', b.id, { sort_order: Number(a.sort_order) });
    },
    { ...opts, tables: writeScope('categories') },
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
  await writeAction(db, (w) => w.remove('categories', id), {
    ...opts,
    tables: writeScope('categories'),
  });
}

// CSV export (REQ-B02); cost columns only with cost.view (AC 4).

const rupees = rupeesCsv;
const qty = qtyCsv;

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
    'kind',
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
        qty(r.bundle ? (r.bundle.availability ?? 0) * 1000 : r.onHand),
        p.unit,
        qty(Number(p.min_stock_milli ?? 0)),
        p.track_stock === 1 ? 1 : 0,
        p.kind === 'bundle' ? 'bundle' : 'simple',
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

export type StockHistoryCsvRow = {
  at: number;
  reason: string;
  qty: string;
  balanceAfter: string;
  by: string;
};

/** One product's stock history (screens/08). */
export function stockHistoryCsv(
  rows: readonly StockHistoryCsvRow[],
  timeZone: string,
): string {
  const when = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const header = ['date', 'reason', 'qty', 'balance_after', 'by'];
  return `${[header.join(',')]
    .concat(
      rows.map((row) =>
        [
          when.format(row.at).replace(', ', ' '),
          row.reason,
          row.qty,
          row.balanceAfter,
          row.by,
        ]
          .map(csvCell)
          .join(','),
      ),
    )
    .join('\r\n')}\r\n`;
}

/** Stores a generated in-store barcode as a normal product upsert (screens/20). */
export async function addProductBarcode(
  db: BikriDb,
  productId: string,
  barcode: string,
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  return writeAction(
    db,
    (w) =>
      w.create('product_barcodes', {
        product_id: productId,
        barcode,
      }),
    { now, actor, tables: writeScope('product_barcodes') },
  );
}
