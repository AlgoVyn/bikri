import type { BikriDb, MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import {
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
};

export async function loadCatalogueMaster(
  db: BikriDb,
): Promise<CatalogueMaster> {
  const [products, categories, barcodeRows] = await Promise.all([
    db.products.toArray(),
    db.categories.toArray(),
    db.product_barcodes.toArray(),
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

// A sale or refund invalidates the snapshot for the next screen that opens; the Sell
// grid keeps its current order until it remounts, so the counter never waits for this.
onLocalWrite(() => clearSoldCache());

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

/** Build the list rows once; filtering and sorting happen in memory on each keystroke. */
export function buildProductRows(
  master: CatalogueMaster,
  levels: ReadonlyMap<string, number>,
  sold: ReadonlyMap<string, number>,
): ProductListRow[] {
  return master.products.map((product) => {
    const onHand = levels.get(product.id) ?? 0;
    return {
      product,
      category: master.categories.get(String(product.category_id)) ?? null,
      onHand,
      sold30: sold.get(product.id) ?? 0,
      barcodes: master.barcodes.get(product.id) ?? [],
      stockState: stockStateOf(product, onHand),
    };
  });
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

export function useCatalogueRows(
  sold: ReadonlyMap<string, number>,
): ProductListRow[] | undefined {
  const master = useCatalogueMaster();
  const levels = useStockLevels();
  return master === undefined || levels === undefined
    ? undefined
    : buildProductRows(master, levels, sold);
}
