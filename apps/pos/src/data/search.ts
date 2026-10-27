import type { BikriDb } from '@bikri/db';

export type SearchHit = {
  kind: 'product' | 'customer' | 'bill';
  id: string;
  title: string;
  detail: string;
};

const PER_GROUP = 5;

/** Top-bar search (screens/04): name, SKU, barcode, phone or bill number; 5 hits per group. */
export async function searchAll(
  db: BikriDb,
  raw: string,
): Promise<SearchHit[]> {
  const q = raw.trim().toLowerCase();
  if (q === '') return [];
  // 0300… and +92300… are the same number: drop a local leading 0.
  const digits = q.replace(/\D/gu, '').replace(/^0/u, '');
  const words = q.split(/\s+/u);
  const products: SearchHit[] = [];
  const barcodeHits = new Set(
    (
      await db.product_barcodes.where('barcode').equals(raw.trim()).toArray()
    ).map((b) => String(b.product_id)),
  );
  for (const p of await db.products.toArray()) {
    if (p.deleted_at) continue;
    const name = String(p.name_en ?? '');
    const sku = String(p.sku ?? '');
    const haystack =
      `${name} ${String(p.name_ur ?? '')} ${String(p.brand ?? '')} ${sku}`.toLowerCase();
    if (
      words.every((word) => haystack.includes(word)) ||
      barcodeHits.has(p.id)
    ) {
      products.push({ kind: 'product', id: p.id, title: name, detail: sku });
      if (products.length === PER_GROUP) break;
    }
  }
  const customers: SearchHit[] = [];
  for (const c of await db.customers.toArray()) {
    if (c.deleted_at) continue;
    const name = String(c.name ?? '');
    const phone = String(c.phone ?? '');
    if (
      name.toLowerCase().includes(q) ||
      (digits.length >= 3 && phone.replace(/\D/gu, '').includes(digits))
    ) {
      customers.push({
        kind: 'customer',
        id: c.id,
        title: name,
        detail: phone,
      });
      if (customers.length === PER_GROUP) break;
    }
  }
  const bills: SearchHit[] = [];
  for (const s of await db.sales.orderBy('created_at').reverse().toArray()) {
    if (String(s.invoice_no).toLowerCase().includes(q)) {
      bills.push({
        kind: 'bill',
        id: s.id,
        title: String(s.invoice_no),
        detail: String(s.business_date),
      });
      if (bills.length === PER_GROUP) break;
    }
  }
  return [...products, ...customers, ...bills];
}
