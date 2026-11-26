import type { BikriDb, MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type BundleInfo,
  buildBundleInfoMap,
  bundleInfoOf,
  filterAndSortProducts,
  type ProductListRow,
  soldByProduct,
  stockStateOf,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { onLocalWrite } from '../data/write.ts';

/**
 * Catalogue reads for the Sell grid and the Products list.
 *
 * The master rows and the stock levels are separate live queries: a sale only changes
 * `stock_levels`, so it must not re-read every product, barcode and category. The 30-day
 * sales figure is a session cache (not a live query) — otherwise every completed sale
 * would re-run the whole catalogue query.
 */
export type CatalogueMaster = {
  products: MasterRow[];
  categories: Map<string, MasterRow>;
  barcodes: Map<string, string[]>;
  bundleItems: MasterRow[];
};

export async function loadCatalogueMaster(
  db: BikriDb,
): Promise<CatalogueMaster> {
  const [products, categories, barcodeRows, bundleItems] = await Promise.all([
    db.products.toArray(),
    db.categories.toArray(),
    db.product_barcodes.toArray(),
    db.bundle_items.toArray(),
  ]);
  const categoryMap = new Map(
    categories
      .filter((category) => !category.deleted_at)
      .map((category) => [category.id, category]),
  );
  const barcodes = new Map<string, string[]>();
  for (const row of barcodeRows) {
    if (row.deleted_at) continue;
    const id = String(row.product_id);
    barcodes.set(id, [...(barcodes.get(id) ?? []), String(row.barcode)]);
  }
  return {
    products: products.filter((product) => !product.deleted_at),
    categories: categoryMap,
    barcodes,
    bundleItems: bundleItems.filter((row) => !row.deleted_at),
  };
}

export function useCatalogueMaster(): CatalogueMaster | undefined {
  const warm = getWarmCatalogue(getDb().tenantId)?.master;
  return useLiveQuery(() => loadCatalogueMaster(getDb()), [], warm);
}

export async function loadStockLevels(
  db: BikriDb,
): Promise<Map<string, number>> {
  return new Map(
    (await db.stock_levels.toArray()).map((level) => [
      level.product_id,
      level.on_hand_milli,
    ]),
  );
}

export function useStockLevels(): Map<string, number> | undefined {
  const warm = getWarmCatalogue(getDb().tenantId)?.levels;
  return useLiveQuery(() => loadStockLevels(getDb()), [], warm);
}

/** A short-lived prewarm from the lock screen; the live queries still own freshness. */
const WARM_TTL_MS = 5 * 60_000;
type WarmCatalogue = {
  tenant: string;
  at: number;
  master: CatalogueMaster;
  levels: Map<string, number>;
  sold: Map<string, number>;
  rows: ProductListRow[];
};
let warmCatalogue: WarmCatalogue | null = null;
let warmInFlight: { tenant: string; promise: Promise<WarmCatalogue> } | null =
  null;

/** Load the catalogue while the lock screen is visible; the PIN typing hides the read. */
export function prewarmSellCatalogue(
  db: BikriDb,
  costMethod: 'avg' | 'last' = 'avg',
  now = Date.now(),
): Promise<WarmCatalogue> {
  if (
    warmCatalogue?.tenant === db.tenantId &&
    now - warmCatalogue.at < WARM_TTL_MS
  )
    return Promise.resolve(warmCatalogue);
  // An in-flight warm-up belongs to the tenant that started it. A shop switch must
  // start a new read instead of returning the old tenant's promise.
  if (warmInFlight?.tenant === db.tenantId) return warmInFlight.promise;
  const tenant = db.tenantId;
  let promise!: Promise<WarmCatalogue>;
  promise = (async () => {
    const [master, levels, sold] = await Promise.all([
      loadCatalogueMaster(db),
      loadStockLevels(db),
      sold30For(db),
    ]);
    const index = buildCatalogueIndex(master, levels, sold, costMethod);
    const result: WarmCatalogue = {
      tenant,
      at: Date.now(),
      master,
      levels,
      sold,
      rows: index.rows,
    };
    // A later tenant's warm-up may have replaced this one while it was reading.
    if (warmInFlight?.promise === promise) warmCatalogue = result;
    return result;
  })().finally(() => {
    if (warmInFlight?.promise === promise) warmInFlight = null;
  });
  warmInFlight = { tenant, promise };
  return promise;
}

export function getWarmCatalogue(
  tenant: string,
  now = Date.now(),
): WarmCatalogue | null {
  return warmCatalogue?.tenant === tenant &&
    now - warmCatalogue.at < WARM_TTL_MS
    ? warmCatalogue
    : null;
}

/** Test/shop-switch hook. */
export function clearWarmCatalogue(): void {
  warmCatalogue = null;
  warmInFlight = null;
}

const SOLD_TTL_MS = 5 * 60_000;
let soldCache: {
  tenant: string;
  at: number;
  value: Map<string, number>;
} | null = null;

export async function sold30For(db: BikriDb): Promise<Map<string, number>> {
  if (
    soldCache?.tenant === db.tenantId &&
    Date.now() - soldCache.at < SOLD_TTL_MS
  )
    return soldCache.value;
  const shop = await db.shop.get('shop');
  const timeZone = String(shop?.timezone ?? '') || 'Asia/Karachi';
  const value = await soldByProduct(db, 30, Date.now(), timeZone);
  soldCache = { tenant: db.tenantId, at: Date.now(), value };
  return value;
}

/** Clear after a restore/leave-shop or in tests; normal writes keep the 5-minute cache. */
export function clearSoldCache(): void {
  soldCache = null;
}

const SOLD_TABLES = new Set([
  'sales',
  'sale_lines',
  'refunds',
  'refund_lines',
  'sale_voids',
]);
const WARM_TABLES = new Set([
  'products',
  'product_barcodes',
  'bundle_items',
  'categories',
  'stock_levels',
  'shop',
]);

// A sale or refund invalidates the snapshot for the next screen that opens; the Sell
// grid keeps its current order until it remounts, so the counter never waits for this.
// A product edit or a settings write no longer throws the snapshot away.
onLocalWrite((_count, tables) => {
  if (tables.some((table) => SOLD_TABLES.has(table))) clearSoldCache();
  if (tables.some((table) => WARM_TABLES.has(table))) clearWarmCatalogue();
});

export function useSold30(): Map<string, number> | undefined {
  const [sold, setSold] = useState<Map<string, number> | undefined>(
    () => getWarmCatalogue(getDb().tenantId)?.sold,
  );
  useEffect(() => {
    let alive = true;
    const db = getDb();
    void sold30For(db).then((value) => {
      if (alive) setSold(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return sold;
}

/** One row; the haystack is built once here so a keystroke only runs `includes`. */
function buildProductRow(
  product: MasterRow,
  master: CatalogueMaster,
  levels: ReadonlyMap<string, number>,
  sold: ReadonlyMap<string, number>,
  bundle: BundleInfo | undefined,
): ProductListRow {
  const onHand = bundle
    ? (bundle.availability ?? 0) * 1000
    : (levels.get(product.id) ?? 0);
  const row: ProductListRow = {
    product,
    category: master.categories.get(String(product.category_id)) ?? null,
    onHand,
    sold30: sold.get(product.id) ?? 0,
    barcodes: master.barcodes.get(product.id) ?? [],
    stockState: stockStateOf(product, onHand, bundle),
    ...(bundle ? { bundle } : {}),
  };
  return { ...row, haystack: productHaystack(row) };
}

/** Build the list rows once; filtering and sorting happen in memory on each keystroke. */
export function buildProductRows(
  master: CatalogueMaster,
  levels: ReadonlyMap<string, number>,
  sold: ReadonlyMap<string, number>,
  costMethod: 'avg' | 'last' = 'avg',
): ProductListRow[] {
  const bundles = buildBundleInfoMap(
    master.products,
    master.bundleItems,
    levels,
    costMethod,
  );
  return master.products.map((product) =>
    buildProductRow(product, master, levels, sold, bundles.get(product.id)),
  );
}

/** A product row's barcode list as a flat search haystack (used by the Sell filter). */
export function productHaystack(row: ProductListRow): string {
  return [
    row.product.name_en,
    row.product.name_ur,
    row.product.brand,
    row.product.sku,
    ...row.barcodes,
  ]
    .map((value) => String(value ?? '').toLowerCase())
    .join(' ');
}

type CatalogueIndex = {
  /** Rows in Sell order (`best`), so a stock patch keeps their positions. */
  rows: ProductListRow[];
  levels: ReadonlyMap<string, number>;
  index: Map<string, number>;
  productsById: Map<string, MasterRow>;
  /** One bundle's recipe rows, for recomputing only the affected bundles. */
  recipes: Map<string, MasterRow[]>;
  /** component product id → active bundle ids that use it. */
  componentBundles: Map<string, string[]>;
};

type CatalogueCache = CatalogueIndex & {
  master: CatalogueMaster;
  sold: ReadonlyMap<string, number>;
  levels: ReadonlyMap<string, number>;
  costMethod: 'avg' | 'last';
};

/** Build the cached rows and the lookup structures the stock patch needs. */
export function buildCatalogueIndex(
  master: CatalogueMaster,
  levels: ReadonlyMap<string, number>,
  sold: ReadonlyMap<string, number>,
  costMethod: 'avg' | 'last',
): CatalogueIndex {
  const recipes = new Map<string, MasterRow[]>();
  const componentBundles = new Map<string, string[]>();
  for (const item of master.bundleItems) {
    const bundleId = String(item.bundle_id);
    recipes.set(bundleId, [...(recipes.get(bundleId) ?? []), item]);
    const componentId = String(item.component_product_id);
    const usedBy = componentBundles.get(componentId) ?? [];
    if (!usedBy.includes(bundleId)) usedBy.push(bundleId);
    componentBundles.set(componentId, usedBy);
  }
  const rows = filterAndSortProducts(
    buildProductRows(master, levels, sold, costMethod),
    { sort: 'best' },
  );
  return {
    rows,
    levels,
    index: new Map(rows.map((row, index) => [row.product.id, index])),
    productsById: new Map(
      master.products.map((product) => [product.id, product]),
    ),
    recipes,
    componentBundles,
  };
}

/**
 * Patch only the rows whose stock changed. A component sale also recomputes the bundles
 * whose recipe uses it. Returns `null` when more than 500 rows changed (a bulk import),
 * where a full rebuild is cheaper than per-row work.
 */
export function patchCatalogueIndex(
  prev: CatalogueIndex,
  levels: ReadonlyMap<string, number>,
  costMethod: 'avg' | 'last',
): ProductListRow[] | null {
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const [id, level] of levels) {
    seen.add(id);
    if (prev.levels.get(id) !== level) changed.push(id);
  }
  for (const id of prev.levels.keys()) {
    if (!seen.has(id)) changed.push(id);
  }
  if (changed.length === 0) return prev.rows;
  if (changed.length > 500) return null;
  const rows = prev.rows.slice();
  const affectedBundles = new Set<string>();
  for (const id of changed) {
    const product = prev.productsById.get(id);
    const index = prev.index.get(id);
    // A bundle row's on-hand is its components' availability, not its own level.
    if (index !== undefined && product && product.kind !== 'bundle') {
      const old = rows[index];
      if (old) {
        const onHand = levels.get(id) ?? 0;
        rows[index] = {
          ...old,
          onHand,
          stockState: stockStateOf(product, onHand),
        };
      }
    }
    for (const bundleId of prev.componentBundles.get(id) ?? [])
      affectedBundles.add(bundleId);
  }
  for (const bundleId of affectedBundles) {
    const index = prev.index.get(bundleId);
    const product = prev.productsById.get(bundleId);
    const old = index === undefined ? undefined : rows[index];
    if (index === undefined || !product || !old) continue;
    const bundle = bundleInfoOf(
      bundleId,
      prev.recipes.get(bundleId) ?? [],
      prev.productsById,
      levels,
      costMethod,
    );
    const onHand = (bundle.availability ?? 0) * 1000;
    rows[index] = {
      ...old,
      bundle,
      onHand,
      stockState: stockStateOf(product, onHand, bundle),
    };
  }
  return rows;
}

/**
 * Sell/Products rows, already sorted in Sell order (`best`). A sale invalidates the
 * `stock_levels` live query; patching the few rows whose level changed keeps the
 * per-sale cost proportional to the sale instead of the catalogue. A component sale
 * also recomputes only the bundles whose recipe uses that component, so a shop with
 * bundles keeps the incremental path (D-231).
 */
export function useCatalogueRows(
  sold: ReadonlyMap<string, number>,
  costMethod: 'avg' | 'last' = 'avg',
): ProductListRow[] | undefined {
  const master = useCatalogueMaster();
  const levels = useStockLevels();
  const cache = useRef<CatalogueCache | null>(null);
  return useMemo(() => {
    if (master === undefined || levels === undefined) return undefined;
    const prev = cache.current;
    if (
      prev !== null &&
      prev.master === master &&
      prev.sold === sold &&
      prev.costMethod === costMethod
    ) {
      const rows = patchCatalogueIndex(prev, levels, costMethod);
      if (rows !== null) {
        cache.current = { ...prev, levels, rows };
        return rows;
      }
    }
    const index = buildCatalogueIndex(master, levels, sold, costMethod);
    cache.current = { master, sold, costMethod, ...index };
    return index.rows;
  }, [master, levels, sold, costMethod]);
}
