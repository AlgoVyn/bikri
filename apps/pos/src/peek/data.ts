import { businessDate, saleLineFinal } from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import {
  bundleInfoOf,
  loadBundleRecipe,
  type MovementHistoryRow,
  productStockHistoryPage,
} from '../data/catalog.ts';
import {
  type DeliveryDetail,
  deliveryDetail,
  generatedInvoiceNo,
} from '../data/purchases.ts';
import { type BillDetail, billDetail } from '../data/salesHistory.ts';
import { shopTimeZone } from '../data/shopTimeZone.ts';
import { customerStatement, type Statement } from '../data/udhaar.ts';
import { marginText } from '../lib/productFormat.ts';

export type ProductPeekData = {
  product: MasterRow;
  category: MasterRow | null;
  onHand: number | null;
  price: number;
  cost: number;
  margin: string | null;
  minStock: number;
  unit: string;
  timeZone: string;
  today: string;
  lastSale: { date: string; invoice: string; branchId: string } | null;
  lastDelivery: {
    date: string;
    invoice: string;
    supplier: string | null;
  } | null;
  history: {
    id: string;
    date: string;
    reasonCode: string;
    qtyMilli: number;
    balanceAfter: number;
  }[];
};

export type BillPeekData = {
  detail: BillDetail;
  timeZone: string;
  today: string;
};

export type QuotationPeekData = {
  quote: SyncedRow;
  lines: SyncedRow[];
  timeZone: string;
  today: string;
  staffName: string;
  deviceName: string;
};

export type CustomerPeekData = {
  customer: MasterRow;
  balance: number;
  creditLimit: number;
  oldestUnpaidAt: number | null;
  promise: SyncedRow | null;
  statement: Statement;
  timeZone: string;
};

export type DeliveryPeekData = {
  detail: DeliveryDetail;
  invoiceNo: string;
  timeZone: string;
};

/** Enough recent movements to find a sale/delivery on a fast-moving product. */
const PEEK_REF_SCAN = 200;

export async function loadProductPeek(
  db: BikriDb,
  id: string,
): Promise<ProductPeekData | null> {
  const product = await db.products.get(id);
  if (!product || product.deleted_at) return null;
  const [category, level, shop, historyPage, recentMovements, timeZone] =
    await Promise.all([
      product.category_id
        ? db.categories.get(String(product.category_id))
        : Promise.resolve(undefined),
      db.stock_levels.get(id),
      db.shop.get('shop'),
      // Only the three rows shown in the peek; the refs below use their own scan.
      productStockHistoryPage(db, id, 3),
      db.stock_movements
        .where('[product_id+created_at]')
        .between([id, 0], [id, Number.MAX_SAFE_INTEGER])
        .reverse()
        .limit(PEEK_REF_SCAN)
        .toArray(),
      shopTimeZone(db),
    ]);
  const movements = historyPage.rows.filter(
    (row): row is MovementHistoryRow => row.kind === 'movement',
  );
  const isBundle = product.kind === 'bundle';
  const bundleInfo = isBundle
    ? await (async () => {
        const items = await loadBundleRecipe(db, id);
        const ids = items.map((item) => String(item.component_product_id));
        const components = new Map(
          (await db.products.bulkGet(ids))
            .filter((row): row is MasterRow => row !== undefined)
            .map((row) => [row.id, row]),
        );
        const levels = new Map(
          (await db.stock_levels.bulkGet(ids)).flatMap((level) =>
            level ? [[level.product_id, level.on_hand_milli] as const] : [],
          ),
        );
        return bundleInfoOf(
          id,
          items,
          components,
          levels,
          String(shop?.cost_method) === 'last' ? 'last' : 'avg',
        );
      })()
    : null;
  const saleMovement = recentMovements.find(
    (movement) =>
      String(movement.reason_code) === 'sale' &&
      movement.ref_type === 'sale' &&
      movement.ref_id !== null &&
      movement.ref_id !== undefined,
  );
  const deliveryMovement = recentMovements.find(
    (movement) =>
      String(movement.reason_code) === 'purchase' &&
      movement.ref_type === 'purchase' &&
      movement.ref_id !== null &&
      movement.ref_id !== undefined,
  );
  const [sale, purchase, bundleSaleLine] = await Promise.all([
    saleMovement?.ref_id
      ? db.sales.get(String(saleMovement.ref_id))
      : Promise.resolve(undefined),
    deliveryMovement?.ref_id
      ? db.purchases.get(String(deliveryMovement.ref_id))
      : Promise.resolve(undefined),
    isBundle
      ? (async () => {
          // The compound index orders by business date, not created_at; pick the
          // newest line within the latest date so "Last sold" shows the latest invoice.
          const latest = await db.sale_lines
            .where('[bundle_id+business_date]')
            .between([id, ''], [id, '9999-12-31'])
            .reverse()
            .first();
          if (!latest) return undefined;
          const sameDate = await db.sale_lines
            .where('[bundle_id+business_date]')
            .equals([id, String(latest.business_date)])
            .toArray();
          return sameDate.reduce((newest, row) =>
            Number(row.created_at) > Number(newest.created_at) ? row : newest,
          );
        })()
      : Promise.resolve(undefined),
  ]);
  const bundleSale = bundleSaleLine
    ? await db.sales.get(String(bundleSaleLine.sale_id))
    : undefined;
  const lastSale = isBundle ? bundleSale : sale;
  const supplier = purchase
    ? await db.suppliers.get(String(purchase.supplier_id))
    : undefined;
  const liveSupplier = supplier && !supplier.deleted_at ? supplier : undefined;
  const price = Number(product.price);
  const cost = isBundle
    ? Number(bundleInfo?.cost ?? 0)
    : String(shop?.cost_method) === 'last'
      ? Number(product.last_cost ?? 0)
      : Number(product.avg_cost ?? 0);
  const lastDeliveryInvoice =
    purchase === undefined
      ? ''
      : String(purchase.supplier_invoice_no ?? '').trim() ||
        generatedInvoiceNo(String(purchase.id), String(purchase.business_date));

  return {
    product,
    category: category ?? null,
    onHand: isBundle
      ? bundleInfo?.availability === null || bundleInfo === null
        ? null
        : bundleInfo.availability * 1000
      : Number(product.track_stock) === 1
        ? (level?.on_hand_milli ?? 0)
        : null,
    price,
    cost,
    margin: marginText(price, cost),
    minStock: isBundle ? 0 : Number(product.min_stock_milli ?? 0),
    unit: isBundle ? 'pc' : String(product.unit ?? 'pc'),
    timeZone,
    today: businessDate(Date.now(), timeZone),
    lastSale: lastSale
      ? {
          date: String(lastSale.business_date),
          invoice: String(lastSale.invoice_no),
          branchId: String(lastSale.branch_id ?? ''),
        }
      : null,
    lastDelivery:
      !isBundle && purchase
        ? {
            date: String(purchase.business_date),
            invoice: lastDeliveryInvoice,
            supplier: liveSupplier ? String(liveSupplier.name) : null,
          }
        : null,
    history: isBundle
      ? []
      : movements.slice(0, 3).map((row) => {
          const movement = row.kind === 'movement' ? row.movement : null;
          return {
            id: movement ? String(movement.id) : '',
            date: movement ? String(movement.business_date) : '',
            reasonCode: movement ? String(movement.reason_code) : '',
            qtyMilli: movement ? Number(movement.qty_delta_milli) : 0,
            balanceAfter: row.balanceAfter,
          };
        }),
  };
}

export async function loadBillPeek(
  db: BikriDb,
  id: string,
): Promise<BillPeekData | null> {
  const detail = await billDetail(db, id);
  if (!detail) return null;
  const timeZone = await shopTimeZone(db);
  return { detail, timeZone, today: businessDate(Date.now(), timeZone) };
}

export async function loadQuotationPeek(
  db: BikriDb,
  id: string,
): Promise<QuotationPeekData | null> {
  const quote = await db.quotations.get(id);
  if (!quote) return null;
  const [lines, timeZone, staff, device] = await Promise.all([
    db.quotation_lines.where('quote_id').equals(id).sortBy('line_no'),
    shopTimeZone(db),
    quote.staff_id ? db.staff.get(String(quote.staff_id)) : undefined,
    quote.device_id ? db.devices.get(String(quote.device_id)) : undefined,
  ]);
  return {
    quote,
    lines: lines.filter(
      (line) => line.deleted_at === null || line.deleted_at === undefined,
    ),
    timeZone,
    today: businessDate(Date.now(), timeZone),
    staffName: staff ? String(staff.name) : '',
    deviceName: device ? String(device.name) : '',
  };
}

export async function loadCustomerPeek(
  db: BikriDb,
  id: string,
): Promise<CustomerPeekData | null> {
  const customer = await db.customers.get(id);
  if (!customer || customer.deleted_at) return null;
  const [balanceRow, statement, promises, timeZone] = await Promise.all([
    db.party_balances.get(['customer', id]),
    customerStatement(db, id, undefined, 3),
    db.promises.where('customer_id').equals(id).toArray(),
    shopTimeZone(db),
  ]);
  const promise =
    promises
      .filter((row) => !row.deleted_at && String(row.status) === 'open')
      .sort((a, b) =>
        String(a.promised_on).localeCompare(String(b.promised_on)),
      )[0] ?? null;
  return {
    customer,
    balance: balanceRow?.balance ?? statement.balance,
    creditLimit: Number(customer.credit_limit ?? 0),
    oldestUnpaidAt: balanceRow?.oldest_unpaid_at ?? null,
    promise,
    statement,
    timeZone,
  };
}

export async function loadDeliveryPeek(
  db: BikriDb,
  id: string,
): Promise<DeliveryPeekData | null> {
  const detail = await deliveryDetail(db, id);
  if (!detail) return null;
  const timeZone = await shopTimeZone(db);
  const invoiceNo =
    String(detail.purchase.supplier_invoice_no ?? '').trim() ||
    generatedInvoiceNo(id, String(detail.purchase.business_date));
  return { detail, invoiceNo, timeZone };
}

export function billPaidTotal(detail: BillDetail): number {
  return detail.payments
    .filter((payment) => String(payment.direction) === 'in')
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
}

export function billLineTotal(detail: BillDetail, line: SyncedRow): number {
  return saleLineFinal(
    {
      net: Number(line.net),
      bill_discount_alloc: Number(line.bill_discount_alloc),
      tax_alloc: Number(line.tax_alloc),
      rounding_alloc: Number(line.rounding_alloc),
    },
    Number(detail.sale.tax_inclusive) === 1,
  );
}
