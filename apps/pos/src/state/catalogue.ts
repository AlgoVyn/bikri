import type { BikriDb, MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type BundleInfo,
  buildBundleInfoMap,
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
  return useLiveQuery(() => loadCatalogueMaster(getDb()), []);
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
  return useLiveQuery(() => loadStockLevels(getDb()), []);
}

/** A short-lived session cache: 30-day sold quantities do not need to update mid-session. */
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
  const value = await soldByProduct(db, 30);
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

// A sale or refund invalidates the snapshot for the next screen that opens; the Sell
// grid keeps its current order until it remounts, so the counter never waits for this.
// A product edit or a settings write no longer throws the snapshot away.
onLocalWrite((_count, tables) => {
  if (tables.some((table) => SOLD_TABLES.has(table))) clearSoldCache();
});

export function useSold30(): Map<string, number> | undefined {
  const [sold, setSold] = useState<Map<string, number> | undefined>(undefined);
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

type CatalogueCache = {
  master: CatalogueMaster;
  sold: ReadonlyMap<string, number>;
  levels: ReadonlyMap<string, number>;
  costMethod: 'avg' | 'last';
  rows: ProductListRow[];
  index: Map<string, number>;
};

/**
 * Sell/Products rows. A sale invalidates the `stock_levels` live query; patching
 * the few rows whose level changed keeps the per-sale cost proportional to the
 * sale instead of the catalogue. Shops with bundles fall back to a full rebuild
 * because a component sale changes the bundle's availability (D-231).
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
      prev.costMethod === costMethod &&
      master.bundleItems.length === 0
    ) {
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
      if (changed.length <= 500) {
        const rows = prev.rows.slice();
        for (const id of changed) {
          const index = prev.index.get(id);
          if (index === undefined) continue;
          const product = master.products[index];
          const old = rows[index];
          if (!product || !old) continue;
          const onHand = levels.get(id) ?? 0;
          rows[index] = {
            ...old,
            onHand,
            stockState: stockStateOf(product, onHand),
          };
        }
        cache.current = { ...prev, levels, rows };
        return rows;
      }
    }
    const rows = buildProductRows(master, levels, sold, costMethod);
    cache.current = {
      master,
      sold,
      levels,
      costMethod,
      rows,
      index: new Map(rows.map((row, index) => [row.product.id, index])),
    };
    return rows;
  }, [master, levels, sold, costMethod]);
}
