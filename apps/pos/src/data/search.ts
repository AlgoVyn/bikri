import type { BikriDb } from '@bikri/db';
import { onLocalWrite } from './write.ts';

export type SearchHit = {
  kind: 'product' | 'customer' | 'bill';
  id: string;
  title: string;
  detail: string;
  /** Product selling price in paisa; the search overlay shows it for price lookups. */
  price?: number;
};

const PER_GROUP = 5;
/** Catalogue/customer/invoice lookups are reused across keystrokes for a short time. */
const CACHE_TTL_MS = 30_000;

type ProductRow = {
  id: string;
  name_en?: unknown;
  name_ur?: unknown;
  brand?: unknown;
  sku?: unknown;
  price?: unknown;
  deleted_at?: unknown;
};

type CustomerRow = {
  id: string;
  name?: unknown;
  phone?: unknown;
  deleted_at?: unknown;
};

type InvoiceRow = {
  id: string;
  invoice_no: unknown;
  business_date: unknown;
  branch_id?: unknown;
  created_at: unknown;
};

type SearchCache = {
  tenant: string;
  at: number;
  products: ProductRow[];
  customers: CustomerRow[];
};

let cache: SearchCache | null = null;
let invoiceCache: { tenant: string; at: number; rows: InvoiceRow[] } | null =
  null;

async function searchCache(db: BikriDb): Promise<SearchCache> {
  if (
    cache !== null &&
    cache.tenant === db.tenantId &&
    Date.now() - cache.at < CACHE_TTL_MS
  )
    return cache;
  const [products, customers] = await Promise.all([
    db.products.toArray(),
    db.customers.toArray(),
  ]);
  cache = {
    tenant: db.tenantId,
    at: Date.now(),
    products: products as ProductRow[],
    customers: customers as CustomerRow[],
  };
  return cache;
}

async function invoicesFor(db: BikriDb): Promise<InvoiceRow[]> {
  if (
    invoiceCache !== null &&
    invoiceCache.tenant === db.tenantId &&
    Date.now() - invoiceCache.at < CACHE_TTL_MS
  )
    return invoiceCache.rows;
  const rows = (await db.sales.toArray()).map((row) => ({
    id: String(row.id),
    invoice_no: row.invoice_no,
    business_date: row.business_date,
    branch_id: row.branch_id,
    created_at: row.created_at,
  }));
  invoiceCache = { tenant: db.tenantId, at: Date.now(), rows };
  return rows;
}

/** Tests and "leave shop" clear the session cache. */
export function clearSearchCache(): void {
  cache = null;
  invoiceCache = null;
}

// A product/customer/sale written on this device must be searchable immediately.
onLocalWrite(() => clearSearchCache());

/** Top-bar search (screens/04): name, SKU, barcode, phone or bill number; 5 hits per group. */
export async function searchAll(
  db: BikriDb,
  raw: string,
  scope?: { allDates: boolean; today: string; branchId?: string | null },
): Promise<SearchHit[]> {
  const q = raw.trim().toLowerCase();
  if (q === '') return [];
  // 0300… and +92300… are the same number: drop a local leading 0.
  const digits = q.replace(/\D/gu, '').replace(/^0/u, '');
  const words = q.split(/\s+/u);
  const data = await searchCache(db);
  const barcodeHits = new Set(
    (
      await db.product_barcodes.where('barcode').equals(raw.trim()).toArray()
    ).map((b) => String(b.product_id)),
  );
  const products: SearchHit[] = [];
  for (const p of data.products) {
    if (p.deleted_at) continue;
    const name = String(p.name_en ?? '');
    const sku = String(p.sku ?? '');
    const haystack =
      `${name} ${String(p.name_ur ?? '')} ${String(p.brand ?? '')} ${sku}`.toLowerCase();
    if (
      words.every((word) => haystack.includes(word)) ||
      barcodeHits.has(String(p.id))
    ) {
      products.push({
        kind: 'product',
        id: String(p.id),
        title: name,
        detail: sku,
        price: Number(p.price ?? 0),
      });
      if (products.length === PER_GROUP) break;
    }
  }
  const customers: SearchHit[] = [];
  for (const c of data.customers) {
    if (c.deleted_at) continue;
    const name = String(c.name ?? '');
    const phone = String(c.phone ?? '');
    if (
      name.toLowerCase().includes(q) ||
      (digits.length >= 3 && phone.replace(/\D/gu, '').includes(digits))
    ) {
      customers.push({
        kind: 'customer',
        id: String(c.id),
        title: name,
        detail: phone,
      });
      if (customers.length === PER_GROUP) break;
    }
  }
  const billMatch = (row: InvoiceRow): boolean => {
    if (scope && !scope.allDates && String(row.business_date) !== scope.today)
      return false;
    if (
      scope?.branchId &&
      String(row.branch_id ?? '') !== String(scope.branchId)
    )
      return false;
    return String(row.invoice_no).toLowerCase().includes(q);
  };
  const bills: SearchHit[] = [];
  const seen = new Set<string>();
  const matchedBills: InvoiceRow[] = [];
  const addBill = (row: InvoiceRow) => {
    if (seen.has(row.id) || !billMatch(row)) return;
    seen.add(row.id);
    matchedBills.push(row);
  };
  // A typed prefix is the common case and uses the unique invoice index directly.
  const prefix = raw.trim().toUpperCase();
  if (prefix !== '') {
    for (const row of await db.sales
      .where('invoice_no')
      .startsWith(prefix)
      .limit(PER_GROUP * 8)
      .toArray())
      addBill(row as InvoiceRow);
  }
  if (matchedBills.length < PER_GROUP) {
    for (const row of await invoicesFor(db)) addBill(row);
  }
  matchedBills.sort(
    (a, b) =>
      Number(b.created_at ?? 0) - Number(a.created_at ?? 0) ||
      String(b.id).localeCompare(String(a.id)),
  );
  for (const row of matchedBills.slice(0, PER_GROUP))
    bills.push({
      kind: 'bill',
      id: row.id,
      title: String(row.invoice_no),
      detail: String(row.business_date),
    });
  return [...products, ...customers, ...bills];
}
