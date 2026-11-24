import type { Cart, MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useMemo } from 'react';
import {
  addBundle,
  addProduct,
  type CartId,
  emptyCart,
  loadCarts,
  type ShopMoney,
  shopMoney,
} from '../data/cart.ts';
import { loadBundleRecipe, type ProductListRow } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import {
  getWarmCatalogue,
  useCatalogueRows,
  useSold30,
} from '../state/catalogue.ts';

export type SellRow = ProductListRow & { haystack: string };

const NO_SOLD = new Map<string, number>();

/**
 * Products in Sell order (30-day sales on this till, then name) with a search haystack.
 * `useCatalogueRows` already sorts in this order and keeps positions when it patches a
 * stock level, so a completed bill never re-sorts the catalogue.
 */
export function useSellProducts(): SellRow[] | undefined {
  const sold = useSold30();
  // `buildProductRows` always sets the haystack; the cast avoids re-spreading rows.
  const rows = useCatalogueRows(sold ?? NO_SOLD) as SellRow[] | undefined;
  return (
    rows ?? (getWarmCatalogue(getDb().tenantId)?.rows as SellRow[] | undefined)
  );
}

/** Every word must appear; an exact barcode or SKU also matches. */
export function filterRows(rows: readonly SellRow[], query: string): SellRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice();
  const words = q.split(/\s+/u);
  return rows.filter((r) => words.every((w) => r.haystack.includes(w)));
}

export function useShopMoney(): ShopMoney {
  const shop = useLiveQuery(() => getDb().shop.get('shop'), []);
  return useMemo(() => shopMoney(shop), [shop]);
}

let chain: Promise<unknown> = Promise.resolve();

/** Serialised read-modify-write of one cart, so fast scans never lose an add. */
export function mutateCart(
  id: CartId,
  fn: (cart: Cart) => Cart,
): Promise<Cart> {
  const run = chain.then(async () => {
    const db = getDb();
    const current = (await db.carts.get(id)) ?? emptyCart(id);
    const next = { ...fn(current), id, updated_at: Date.now() };
    await db.carts.put(next);
    return next;
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Adds a product (or a whole bundle) to a cart; the Sell grid and Price check share it. */
export async function addProductToCart(
  id: CartId,
  product: MasterRow,
  qtyMilli: number,
  method: 'avg' | 'last',
): Promise<Cart> {
  const db = getDb();
  if (product.kind !== 'bundle')
    return mutateCart(id, (cart) =>
      addProduct(cart, product, qtyMilli, method),
    );
  const items = await loadBundleRecipe(db, product.id);
  const products = await db.products.bulkGet(
    items.map((row) => String(row.component_product_id)),
  );
  const recipe = items.flatMap((row, index) => {
    const component = products[index];
    return component && !component.deleted_at
      ? [{ product: component, qty_milli: Number(row.qty_milli) }]
      : [];
  });
  const bundles = Math.max(1, Math.floor(qtyMilli / 1000));
  return mutateCart(id, (cart) =>
    addBundle(cart, product, recipe, bundles, method),
  );
}

/** Waits for queued cart writes (before hold, pay or tab switches). */
export function cartsSettled(): Promise<unknown> {
  return chain;
}

export function useCarts(): Record<CartId, Cart> | undefined {
  return useLiveQuery(() => loadCarts(getDb()), []);
}

export function useMutate(id: CartId) {
  return useCallback((fn: (cart: Cart) => Cart) => mutateCart(id, fn), [id]);
}

export function useCustomer(
  id: string | null | undefined,
): { customer: MasterRow; balance: number } | null {
  return (
    useLiveQuery(async () => {
      if (!id) return null;
      const db = getDb();
      const customer = await db.customers.get(id);
      if (!customer) return null;
      const bal = await db.party_balances.get(['customer', id]);
      return { customer, balance: bal?.balance ?? 0 };
    }, [id]) ?? null
  );
}
