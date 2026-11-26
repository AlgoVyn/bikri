/** Builds the printer input for one saved quotation (screens/21). */
import type { BikriDb, SyncedRow } from '@bikri/db';
import { type QuotationReceiptInput, receiptLabelsFor } from '@bikri/printer';
import { receiptShop, resolveReceiptLanguage } from './receipt.ts';

export async function loadQuotationReceipt(
  db: BikriDb,
  quoteId: string,
): Promise<QuotationReceiptInput | null> {
  const quote = await db.quotations.get(quoteId);
  if (!quote) return null;
  const { shop, receiptLanguage } = await receiptShop(db);
  const lines = await db.quotation_lines
    .where('quote_id')
    .equals(quoteId)
    .sortBy('line_no');
  const staff = quote.staff_id
    ? await db.staff.get(String(quote.staff_id))
    : undefined;
  return {
    shop,
    quote: {
      quoteNo: String(quote.quote_no),
      createdAt: Number(quote.created_at),
      businessDate: String(quote.business_date),
      validUntil: String(quote.valid_until),
      customerName: quote.customer_name ? String(quote.customer_name) : null,
      staffName: staff ? String(staff.name) : null,
      itemsQtyMilli: Number(quote.items_qty_milli ?? 0),
      itemDiscountTotal: Number(quote.item_discount_total ?? 0),
      subtotal: Number(quote.subtotal ?? 0),
      billDiscount: Number(quote.bill_discount ?? 0),
      taxRateBp: Number(quote.tax_rate_bp ?? 0),
      tax: Number(quote.tax ?? 0),
      taxInclusive: Number(quote.tax_inclusive ?? 0) === 1,
      rounding: Number(quote.rounding ?? 0),
      total: Number(quote.total ?? 0),
      note: String(quote.note ?? ''),
    },
    lines: lines
      .filter(
        (line: SyncedRow) =>
          line.deleted_at === null || line.deleted_at === undefined,
      )
      .map((line: SyncedRow) => ({
        name: String(line.name_snapshot),
        qtyMilli: Number(line.qty_milli),
        unitPrice: Number(line.unit_price),
        discount: Number(line.discount ?? 0),
        net: Number(line.net),
        warrantyUntil: null,
        bundleGroup: line.bundle_group ? String(line.bundle_group) : null,
        bundleName: line.bundle_name ? String(line.bundle_name) : null,
        bundleQty: line.bundle_qty ? Number(line.bundle_qty) : null,
        bundlePrice:
          line.bundle_price !== null && line.bundle_price !== undefined
            ? Number(line.bundle_price) - Number(line.bundle_discount ?? 0)
            : null,
      })),
    labels: receiptLabelsFor(resolveReceiptLanguage(receiptLanguage)),
  };
}
