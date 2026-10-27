/** Sale receipt blocks, picture, PNG and PDF for Sale complete (screens/07) and print jobs. */
import type { BikriDb, PrintJob } from '@bikri/db';
import {
  type Block,
  buildSaleReceipt,
  type RasterSource,
  type SaleReceiptInput,
} from '@bikri/printer';
import {
  loadSaleReceipt,
  type PrinterKv,
  type ReceiptPaper,
  receiptPaper,
} from '../data/receipt.ts';
import { canvasBlob, jpegToPdf, renderReceiptCanvas } from './receiptImage.ts';

export { downloadBlob } from './receiptImage.ts';

export type SaleReceipt = {
  input: SaleReceiptInput;
  blocks: Block[];
  paper: ReceiptPaper;
  logo: RasterSource | null;
};

export async function saleReceipt(
  db: BikriDb,
  saleId: string,
  options: { reprint?: boolean } = {},
): Promise<SaleReceipt | null> {
  const input = await loadSaleReceipt(db, saleId, options);
  if (!input) return null;
  const paper = receiptPaper(
    ((await db.kv.get('printer'))?.value ?? null) as PrinterKv | null,
  );
  const logo = ((await db.kv.get('logo_bitmap'))?.value ??
    null) as RasterSource | null;
  const blocks = buildSaleReceipt(input, {
    paperMm: paper.paperMm,
    charsPerLine: paper.charsPerLine,
    dots: paper.dots,
    qr: paper.qr,
  });
  return { input, blocks, paper, logo };
}

/** What a sale print job prints (the print service, T-020, sends these blocks). */
export function jobReceipt(db: BikriDb, job: PrintJob) {
  return job.sale_id
    ? saleReceipt(db, job.sale_id, { reprint: job.reprint === true })
    : Promise.resolve(null);
}

export async function receiptPng(r: SaleReceipt): Promise<Blob> {
  const canvas = await renderReceiptCanvas(r.blocks, {
    ...r.paper,
    logo: r.logo,
  });
  return canvasBlob(canvas, 'image/png');
}

export async function receiptPdf(r: SaleReceipt): Promise<Blob> {
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
