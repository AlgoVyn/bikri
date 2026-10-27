import type { Cart, MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useMemo } from 'react';
import {
  type CartId,
  emptyCart,
  loadCarts,
  type ShopMoney,
  shopMoney,
} from '../data/cart.ts';
import { listProducts, type ProductListRow } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';

export type SellRow = ProductListRow & { haystack: string };

/** Products in Sell order (30-day sales on this till, then name) with a search haystack. */
export function useSellProducts(): SellRow[] | undefined {
  const rows = useLiveQuery(() => listProducts(getDb(), { sort: 'best' }), []);
  return useMemo(
    () =>
      rows?.map((r) => ({
        ...r,
        haystack: [
          r.product.name_en,
          r.product.name_ur,
          r.product.brand,
          r.product.sku,
          ...r.barcodes,
        ]
          .map((v) => String(v ?? '').toLowerCase())
          .join(' '),
      })),
    [rows],
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
