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
  name: string;
  sku: string;
  price: number;
  deleted: boolean;
  /** Name, Urdu name, brand and SKU lower-cased once when the cache fills. */
  haystack: string;
};

type CustomerRow = {
  id: string;
  name: string;
  phone: string;
  deleted: boolean;
  searchName: string;
  searchDigits: string;
};

type InvoiceRow = {
  id: string;
  invoice_no: unknown;
  business_date: unknown;
  branch_id?: unknown;
  created_at: unknown;
  /** Lower-cased invoice number, built once per cached row. */
  searchInvoice: string;
};

type RawProductRow = {
  id: unknown;
  name_en?: unknown;
  name_ur?: unknown;
  brand?: unknown;
  sku?: unknown;
  price?: unknown;
  deleted_at?: unknown;
};

type RawCustomerRow = {
  id: unknown;
  name?: unknown;
  phone?: unknown;
  deleted_at?: unknown;
};

type RawInvoiceRow = {
  id: unknown;
  invoice_no: unknown;
  business_date: unknown;
  branch_id?: unknown;
  created_at: unknown;
};

function prepareProduct(row: RawProductRow): ProductRow {
  const name = String(row.name_en ?? '');
  const sku = String(row.sku ?? '');
  return {
    id: String(row.id),
    name,
    sku,
    price: Number(row.price ?? 0),
    deleted: Boolean(row.deleted_at),
    haystack:
      `${name} ${String(row.name_ur ?? '')} ${String(row.brand ?? '')} ${sku}`.toLowerCase(),
  };
}

function prepareCustomer(row: RawCustomerRow): CustomerRow {
  const name = String(row.name ?? '');
  const phone = String(row.phone ?? '');
  return {
    id: String(row.id),
    name,
    phone,
    deleted: Boolean(row.deleted_at),
    searchName: name.toLowerCase(),
    searchDigits: phone.replace(/\D/gu, ''),
  };
}

function prepareInvoice(row: RawInvoiceRow): InvoiceRow {
  return {
    id: String(row.id),
    invoice_no: row.invoice_no,
    business_date: row.business_date,
    branch_id: row.branch_id,
    created_at: row.created_at,
    searchInvoice: String(row.invoice_no).toLowerCase(),
  };
}

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
    products: (products as RawProductRow[]).map(prepareProduct),
    customers: (customers as RawCustomerRow[]).map(prepareCustomer),
  };
  return cache;
}

/** A substring search falls back to this many recent bills, not the whole shop's history. */
const INVOICE_FALLBACK_LIMIT = 2_000;

async function invoicesFor(db: BikriDb): Promise<InvoiceRow[]> {
  if (
    invoiceCache !== null &&
    invoiceCache.tenant === db.tenantId &&
    Date.now() - invoiceCache.at < CACHE_TTL_MS
  )
    return invoiceCache.rows;
  const rows = (
    await db.sales
      .orderBy('created_at')
      .reverse()
      .limit(INVOICE_FALLBACK_LIMIT)
      .toArray()
  ).map((row) => prepareInvoice(row as RawInvoiceRow));
  invoiceCache = { tenant: db.tenantId, at: Date.now(), rows };
  return rows;
}

/** Tests and "leave shop" clear the session cache. */
export function clearSearchCache(): void {
  cache = null;
  invoiceCache = null;
}

export function clearCatalogueSearchCache(): void {
  cache = null;
}

export function clearInvoiceSearchCache(): void {
  invoiceCache = null;
}

const CATALOGUE_TABLES = new Set(['products', 'product_barcodes', 'customers']);
const INVOICE_TABLES = new Set(['sales', 'refunds', 'sale_voids']);

// A product/customer/sale written on this device must be searchable immediately. A sale
// only changes the invoice-number fallback; it must not evict the 5k products/customers
// cache that every keystroke reads.
onLocalWrite((_count, tables) => {
  let catalogue = false;
  let invoice = false;
  for (const table of tables) {
    if (CATALOGUE_TABLES.has(table)) catalogue = true;
    if (INVOICE_TABLES.has(table)) invoice = true;
  }
  if (catalogue) clearCatalogueSearchCache();
  if (invoice) clearInvoiceSearchCache();
});

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
    if (p.deleted) continue;
    if (
      words.every((word) => p.haystack.includes(word)) ||
      barcodeHits.has(p.id)
    ) {
      products.push({
        kind: 'product',
        id: p.id,
        title: p.name,
        detail: p.sku,
        price: p.price,
      });
      if (products.length === PER_GROUP) break;
    }
  }
  const customers: SearchHit[] = [];
  for (const c of data.customers) {
    if (c.deleted) continue;
    if (
      c.searchName.includes(q) ||
      (digits.length >= 3 && c.searchDigits.includes(digits))
    ) {
      customers.push({
        kind: 'customer',
        id: c.id,
        title: c.name,
        detail: c.phone,
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
    return row.searchInvoice.includes(q);
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
      addBill(prepareInvoice(row as RawInvoiceRow));
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
