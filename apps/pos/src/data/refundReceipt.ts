/** Refund receipt data and print job (screens/11). Loaded with the back-office screens. */
import { newId } from '@bikri/core';
import type { BikriDb, SyncedRow } from '@bikri/db';
import {
  type ReceiptLabels,
  type RefundReceipt,
  receiptLabelsFor,
} from '@bikri/printer';
import { customerBalance } from './customers.ts';
import { receiptShop } from './receipt.ts';

/** Everything a refund receipt prints (screens/11), read from this shop's local database. */
export async function loadRefundReceipt(
  db: BikriDb,
  refundId: string,
): Promise<(RefundReceipt & { labels?: Partial<ReceiptLabels> }) | null> {
  const refund = await db.refunds.get(refundId);
  if (!refund) return null;
  const sale = await db.sales.get(String(refund.sale_id));
  if (!sale) return null;
  const { shop, receiptLanguage } = await receiptShop(db);
  const rows = await db.refund_lines
    .where('refund_id')
    .equals(refundId)
    .toArray();
  const saleLines = new Map(
    (await db.sale_lines.bulkGet(rows.map((r) => String(r.sale_line_id))))
      .filter((l): l is SyncedRow => l !== undefined)
      .map((l) => [l.id, l]),
  );
  const staff = refund.staff_id
    ? await db.staff.get(String(refund.staff_id))
    : undefined;
  const customerId = sale.customer_id ? String(sale.customer_id) : null;
  const customer = customerId ? await db.customers.get(customerId) : undefined;
  const udhaar = Number(refund.udhaar_part ?? 0);
  return {
    shop,
    staffName: staff ? String(staff.name) : null,
    customerName: customer ? String(customer.name) : null,
    originalInvoiceNo: String(sale.invoice_no),
    originalCreatedAt: Number(sale.created_at),
    refundCreatedAt: Number(refund.created_at),
    lines: rows.map((row) => ({
      name: String(
        saleLines.get(String(row.sale_line_id))?.name_snapshot ?? '',
      ),
      qtyMilli: Number(row.qty_milli),
      amount: Number(row.amount),
    })),
    exactAmount: Number(refund.exact_amount ?? 0),
    rounding: Number(refund.rounding ?? 0),
    amount: Number(refund.amount ?? 0),
    method: (refund.method as RefundReceipt['method']) ?? null,
    udhaarPart: udhaar,
    khataBalancePaisa:
      udhaar > 0 && customerId ? await customerBalance(db, customerId) : null,
    reason: String(refund.reason),
    labels: receiptLabelsFor(receiptLanguage),
  };
}

/** Queues the refund receipt printed after a refund (screens/11). */
export async function queueRefundPrint(
  db: BikriDb,
  refundId: string,
  options: { now?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const id = newId(now);
  await db.print_jobs.put({
    id,
    refund_id: refundId,
    kind: 'refund',
    status: 'queued',
    created_at: now,
  });
  return id;
}
