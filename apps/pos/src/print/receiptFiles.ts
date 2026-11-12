/** Receipt blocks, pictures, PNG and PDF for sale/refund screens and print jobs (screens/07, 11). */
import { newId } from '@bikri/core';
import type { BikriDb, PrintJob } from '@bikri/db';
import {
  type Block,
  buildDayClose,
  buildRefundReceipt,
  buildSaleReceipt,
  buildSupplierReturn,
  buildVoidNotice,
  type DayCloseReceipt,
  type RasterSource,
  type ReceiptLabels,
  type RefundReceipt,
  type SaleReceiptInput,
  type SupplierReturnReceipt,
  type VoidReceipt,
} from '@bikri/printer';
import { loadDayCloseReceipt } from '../data/dayCloseReceipt.ts';
import {
  loadSaleReceipt,
  type PrinterKv,
  type ReceiptPaper,
  receiptPaper,
  receiptShop,
} from '../data/receipt.ts';
import { loadRefundReceipt } from '../data/refundReceipt.ts';
import { loadSupplierReturnReceipt } from '../data/supplierReturnReceipt.ts';
import { canvasBlob, jpegToPdf, renderReceiptCanvas } from './receiptImage.ts';

export { downloadBlob } from './receiptImage.ts';

type ReceiptLayout = {
  blocks: Block[];
  paper: ReceiptPaper;
  logo: RasterSource | null;
  printer: PrinterKv | null;
};

export type SaleReceipt = ReceiptLayout & { input: SaleReceiptInput };

export type RefundPrint = ReceiptLayout & {
  input: RefundReceipt & { labels?: Partial<ReceiptLabels> };
};

export type VoidPrint = ReceiptLayout & { input: VoidReceipt };

export type DayClosePrint = ReceiptLayout & { input: DayCloseReceipt };

export type SupplierReturnPrint = ReceiptLayout & {
  input: SupplierReturnReceipt;
};

async function layoutOf(db: BikriDb) {
  const printer = ((await db.kv.get('printer'))?.value ??
    null) as PrinterKv | null;
  const paper = receiptPaper(printer);
  const logo = ((await db.kv.get('logo_bitmap'))?.value ??
    null) as RasterSource | null;
  return { printer, paper, logo };
}

export async function saleReceipt(
  db: BikriDb,
  saleId: string,
  options: { reprint?: boolean } = {},
): Promise<SaleReceipt | null> {
  const input = await loadSaleReceipt(db, saleId, options);
  if (!input) return null;
  const { printer, paper, logo } = await layoutOf(db);
  const blocks = buildSaleReceipt(input, {
    paperMm: paper.paperMm,
    charsPerLine: paper.charsPerLine,
    dots: paper.dots,
    qr: paper.qr,
    printLogo: printer?.print_logo !== false,
    // A reprint never opens the drawer (06 §7: cash sales only, once).
    drawer: printer?.drawer !== false && options.reprint !== true,
  });
  return { input, blocks, paper, logo, printer };
}

export async function refundReceipt(
  db: BikriDb,
  refundId: string,
  options: { reprint?: boolean } = {},
): Promise<RefundPrint | null> {
  const input = await loadRefundReceipt(db, refundId);
  if (!input) return null;
  const { printer, paper, logo } = await layoutOf(db);
  const blocks = buildRefundReceipt(input, {
    paperMm: paper.paperMm,
    charsPerLine: paper.charsPerLine,
    dots: paper.dots,
    printLogo: printer?.print_logo !== false,
    // The builder kicks the drawer only when cash is handed back (06 §7), and a
    // reprint must never kick it again.
    drawer: printer?.drawer !== false && options.reprint !== true,
  });
  return { input, blocks, paper, logo, printer };
}

export async function voidReceipt(
  db: BikriDb,
  saleId: string,
): Promise<VoidPrint | null> {
  const voidRow = await db.sale_voids.where('sale_id').equals(saleId).first();
  const sale = await db.sales.get(saleId);
  if (!voidRow || !sale) return null;
  const replacement = voidRow.replacement_sale_id
    ? await db.sales.get(String(voidRow.replacement_sale_id))
    : undefined;
  const staff = voidRow.staff_id
    ? await db.staff.get(String(voidRow.staff_id))
    : undefined;
  const { shop } = await receiptShop(db);
  const input: VoidReceipt = {
    shop,
    staffName: staff ? String(staff.name) : null,
    originalInvoiceNo: String(sale.invoice_no),
    originalCreatedAt: Number(sale.created_at),
    voidCreatedAt: Number(voidRow.created_at),
    reason: String(voidRow.reason),
    replacementInvoiceNo: replacement ? String(replacement.invoice_no) : null,
  };
  const { printer, paper, logo } = await layoutOf(db);
  const blocks = buildVoidNotice(input, {
    paperMm: paper.paperMm,
    charsPerLine: paper.charsPerLine,
    dots: paper.dots,
    printLogo: printer?.print_logo !== false,
  });
  return { input, blocks, paper, logo, printer };
}

/** Queue the cancellation notice after a successful void. */
export async function queueVoidPrint(
  db: BikriDb,
  saleId: string,
  now = Date.now(),
): Promise<string> {
  const id = newId(now);
  await db.print_jobs.put({
    id,
    sale_id: saleId,
    kind: 'void',
    status: 'queued',
    created_at: now,
  });
  return id;
}

export async function dayCloseReceipt(
  db: BikriDb,
  dayCloseId: string,
): Promise<DayClosePrint | null> {
  const input = await loadDayCloseReceipt(db, dayCloseId);
  if (!input) return null;
  const { printer, paper, logo } = await layoutOf(db);
  const blocks = buildDayClose(input, {
    paperMm: paper.paperMm,
    charsPerLine: paper.charsPerLine,
    dots: paper.dots,
    printLogo: printer?.print_logo !== false,
  });
  return { input, blocks, paper, logo, printer };
}

export async function supplierReturnReceipt(
  db: BikriDb,
  returnId: string,
): Promise<SupplierReturnPrint | null> {
  const input = await loadSupplierReturnReceipt(db, returnId);
  if (!input) return null;
  const { printer, paper, logo } = await layoutOf(db);
  const blocks = buildSupplierReturn(input, {
    paperMm: paper.paperMm,
    charsPerLine: paper.charsPerLine,
    dots: paper.dots,
    printLogo: printer?.print_logo !== false,
  });
  return { input, blocks, paper, logo, printer };
}

/** What a print job prints (the print service, T-020, sends these blocks). */
export function jobReceipt(
  db: BikriDb,
  job: PrintJob,
): Promise<
  | SaleReceipt
  | RefundPrint
  | VoidPrint
  | DayClosePrint
  | SupplierReturnPrint
  | null
> {
  if (job.kind === 'void' && job.sale_id) return voidReceipt(db, job.sale_id);
  if (job.sale_id)
    return saleReceipt(db, job.sale_id, { reprint: job.reprint === true });
  if (job.refund_id)
    return refundReceipt(db, job.refund_id, { reprint: job.reprint === true });
  if (job.day_close_id) return dayCloseReceipt(db, job.day_close_id);
  if (job.supplier_return_id)
    return supplierReturnReceipt(db, job.supplier_return_id);
  return Promise.resolve(null);
}

export async function receiptPng(r: ReceiptLayout): Promise<Blob> {
  const canvas = await renderReceiptCanvas(r.blocks, {
    ...r.paper,
    logo: r.logo,
  });
  return canvasBlob(canvas, 'image/png');
}

export async function receiptPdf(r: ReceiptLayout): Promise<Blob> {
  const canvas = await renderReceiptCanvas(r.blocks, {
    ...r.paper,
    logo: r.logo,
  });
  const jpeg = new Uint8Array(
    await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer(),
  );
  const pdf = jpegToPdf(
    jpeg,
    canvas.width,
    canvas.height,
    r.paper.printWidthMm,
  );
  return new Blob([pdf as BlobPart], { type: 'application/pdf' });
}
