import type { BikriDb } from '@bikri/db';
import type { SupplierReturnReceipt } from '@bikri/printer';
import { receiptShop } from './receipt.ts';

/** Stored return + lines for the `RETURN TO SUPPLIER` slip. */
export async function loadSupplierReturnReceipt(
  db: BikriDb,
  returnId: string,
): Promise<SupplierReturnReceipt | null> {
  const row = await db.supplier_returns.get(returnId);
  if (!row) return null;
  const supplier = await db.suppliers.get(String(row.supplier_id));
  if (!supplier) return null;
  const purchase = row.purchase_id
    ? await db.purchases.get(String(row.purchase_id))
    : undefined;
  const lines = await db.supplier_return_lines
    .where('return_id')
    .equals(returnId)
    .toArray();
  const products = await db.products.bulkGet(
    lines.map((line) => String(line.product_id)),
  );
  const productById = new Map(
    products
      .filter((product) => product !== undefined)
      .map((product) => [product.id, product]),
  );
  const { shop } = await receiptShop(db);
  const entries = await db.ledger_entries
    .where('[party_type+party_id+created_at]')
    .between(
      ['supplier', String(row.supplier_id), -Infinity],
      ['supplier', String(row.supplier_id), Number(row.created_at)],
      false,
      true,
    )
    .toArray();
  const balanceAfter = entries.reduce(
    (sum, entry) => sum + Number(entry.amount ?? 0),
    0,
  );
  return {
    shop,
    supplierName: String(supplier.name),
    purchaseInvoice: purchase
      ? String(purchase.supplier_invoice_no || purchase.id)
      : null,
    businessDate: String(row.business_date),
    lines: lines
      .sort((a, b) => Number(a.line_no) - Number(b.line_no))
      .map((line) => ({
        name: String(
          productById.get(String(line.product_id))?.name_en ?? line.product_id,
        ),
        qty: String(Number(line.qty_milli) / 1000),
        unitCredit: Number(line.unit_credit),
        lineTotal: Number(line.line_total),
      })),
    total: Number(row.total),
    refundReceived: Number(row.refund_received),
    refundMethod:
      row.refund_method === 'cash' || row.refund_method === 'bank_wallet'
        ? row.refund_method
        : null,
    reason: String(row.reason),
    note: String(row.note ?? ''),
    balanceAfter,
  };
}

export async function queueSupplierReturnPrint(
  db: BikriDb,
  returnId: string,
  now = Date.now(),
): Promise<string> {
  const id = `sr-print-${returnId}`;
  await db.print_jobs.put({
    id,
    supplier_return_id: returnId,
    kind: 'supplier',
    status: 'queued',
    created_at: now,
  });
  return id;
}
