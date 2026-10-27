import type { BikriDb, MasterRow } from '@bikri/db';
import { findByCode } from './cart.ts';
import { onHand } from './stock.ts';

/** What the price check card shows (screens/18). Read-only: never writes. */
export type PriceCard = {
  product: MasterRow;
  /** null when the product does not track stock (the line is hidden). */
  onHandMilli: number | null;
  barcodes: string[];
};

export type PriceCheckResult =
  | { kind: 'found'; card: PriceCard }
  | { kind: 'matches'; products: MasterRow[] }
  | { kind: 'none' };

export const MAX_MATCHES = 8;

export async function priceCard(
  db: BikriDb,
  product: MasterRow,
): Promise<PriceCard> {
  const rows = await db.product_barcodes
    .where('product_id')
    .equals(product.id)
    .toArray();
  return {
    product,
    onHandMilli:
      product.track_stock === 1 ? await onHand(db, product.id) : null,
    barcodes: rows
      .filter((b) => !b.deleted_at)
      .map((b) => String(b.barcode))
      .sort(),
  };
}

/** A barcode or SKU gives one card; otherwise a name search (every word, English or Urdu). */
export async function priceCheck(
  db: BikriDb,
  query: string,
): Promise<PriceCheckResult> {
  const q = query.trim();
  if (!q) return { kind: 'none' };
  const byCode = await findByCode(db, q);
  if (byCode) return { kind: 'found', card: await priceCard(db, byCode) };
  const words = q.toLowerCase().split(/\s+/u);
  const products = await db.products
    .filter((p) => {
      if (p.deleted_at) return false;
      const hay =
        `${String(p.name_en ?? '')} ${String(p.name_ur ?? '')} ${String(p.brand ?? '')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .limit(MAX_MATCHES)
    .toArray();
  if (products.length === 1) {
    return {
      kind: 'found',
      card: await priceCard(db, products[0] as MasterRow),
    };
  }
  if (products.length === 0) return { kind: 'none' };
  products.sort((a, b) => String(a.name_en).localeCompare(String(b.name_en)));
  return { kind: 'matches', products };
}
