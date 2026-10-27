/** Receipt blocks, pictures, PNG and PDF for sale/refund screens and print jobs (screens/07, 11). */
import type { BikriDb, PrintJob } from '@bikri/db';
import {
  type Block,
  buildRefundReceipt,
  buildSaleReceipt,
  type RasterSource,
  type ReceiptLabels,
  type RefundReceipt,
  type SaleReceiptInput,
} from '@bikri/printer';
import {
  loadSaleReceipt,
  type PrinterKv,
  type ReceiptPaper,
  receiptPaper,
} from '../data/receipt.ts';
import { loadRefundReceipt } from '../data/refundReceipt.ts';
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
): Promise<RefundPrint | null> {
  const input = await loadRefundReceipt(db, refundId);
  if (!input) return null;
  const { printer, paper, logo } = await layoutOf(db);
  const blocks = buildRefundReceipt(input, {
    paperMm: paper.paperMm,
    charsPerLine: paper.charsPerLine,
    dots: paper.dots,
    printLogo: printer?.print_logo !== false,
    // The builder kicks the drawer only when cash is handed back (06 §7).
    drawer: printer?.drawer !== false,
  });
  return { input, blocks, paper, logo, printer };
}

/** What a print job prints (the print service, T-020, sends these blocks). */
export function jobReceipt(
  db: BikriDb,
  job: PrintJob,
): Promise<SaleReceipt | RefundPrint | null> {
  if (job.sale_id)
    return saleReceipt(db, job.sale_id, { reprint: job.reprint === true });
  if (job.refund_id) return refundReceipt(db, job.refund_id);
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
  const pdf = jpegToPdf(jpeg, canvas.width, canvas.height, r.paper.paperMm);
  return new Blob([pdf as BlobPart], { type: 'application/pdf' });
}
