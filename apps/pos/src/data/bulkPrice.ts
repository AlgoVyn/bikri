import { mulDivRound, roundTo } from '@bikri/core';
import type { BikriDb, MasterRow } from '@bikri/db';
import { productAudit } from './catalog.ts';
import type { LedgerContext } from './products.ts';
import { type WriteOptions, writeAction } from './write.ts';

// Update prices (bulk), screens/08.

export type PriceChange =
  | { kind: 'percent'; bp: number }
  | { kind: 'amount'; paisa: number }
  | { kind: 'set'; paisa: number };

/** Rounding step in paisa: none, Rs 1, Rs 5, Rs 10. */
export const ROUNDINGS = [0, 100, 500, 1000] as const;
export type Rounding = (typeof ROUNDINGS)[number];
export const PRICE_CHUNK = 100;

/** New price: change, then round to the step (half away from zero); never below 0. */
export function newPrice(
  old: number,
  change: PriceChange,
  rounding: Rounding,
): number {
  let next =
    change.kind === 'percent'
      ? mulDivRound(old, 10_000 + change.bp, 10_000)
      : change.kind === 'amount'
        ? old + change.paisa
        : change.paisa;
  if (rounding > 0) next = roundTo(next, rounding);
  return Math.max(0, next);
}

export type PriceFilter = {
  categoryId?: string | null;
  brand?: string;
  /** Explicit selection (Select mode); wins over category / brand. */
  ids?: readonly string[];
};

export type PricePreviewRow = { product: MasterRow; old: number; next: number };

export async function pricePreview(
  db: BikriDb,
  filter: PriceFilter,
  change: PriceChange,
  rounding: Rounding,
): Promise<PricePreviewRow[]> {
  const ids = filter.ids ? new Set(filter.ids) : null;
  const brand = filter.brand?.trim().toLowerCase() ?? '';
  const products = (await db.products.toArray()).filter((p) => {
    if (p.deleted_at) return false;
    if (ids) return ids.has(p.id);
    if (filter.categoryId && p.category_id !== filter.categoryId) return false;
    if (
      brand &&
      String(p.brand ?? '')
        .trim()
        .toLowerCase() !== brand
    )
      return false;
    return true;
  });
  products.sort((a, b) => String(a.name_en).localeCompare(String(b.name_en)));
  return products.map((product) => {
    const old = Number(product.price ?? 0);
    return { product, old, next: newPrice(old, change, rounding) };
  });
}

/** One update + `price_change` audit per changed product, 100 products per action. */
export async function applyPrices(
  db: BikriDb,
  rows: readonly PricePreviewRow[],
  ctx: LedgerContext,
  opts: WriteOptions = {},
): Promise<number> {
  const changed = rows.filter((r) => r.next !== r.old);
  for (let start = 0; start < changed.length; start += PRICE_CHUNK) {
    const chunk = changed.slice(start, start + PRICE_CHUNK);
    await writeAction(
      db,
      async (w) => {
        for (const r of chunk) {
          const before = await w.table<MasterRow>('products').get(r.product.id);
          if (!before || before.deleted_at) continue;
          await w.update('products', r.product.id, { price: r.next });
          await productAudit(
            w,
            ctx,
            'price_change',
            r.product.id,
            { price: before.price },
            { price: r.next },
          );
        }
      },
      { actor: ctx.staff_id, ...opts },
    );
  }
  return changed.length;
}
