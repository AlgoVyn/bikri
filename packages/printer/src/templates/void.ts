import { formatReceiptDate } from '../format.ts';
import { resolvePaper } from '../layout.ts';
import type { Block } from '../types.ts';
import {
  labelsFrom,
  pushCenter,
  pushJobEnd,
  pushPair,
  pushPoweredBy,
  pushShopHeader,
  shopNameSize,
  type TemplateSettings,
} from './common.ts';
import type { ReceiptLabels, VoidReceipt } from './types.ts';

/** Cancellation notice for a voided bill (06 §4.3). */
export function buildVoidNotice(
  input: VoidReceipt & { labels?: Partial<ReceiptLabels> },
  settings: TemplateSettings = {},
): Block[] {
  const paper = resolvePaper(settings);
  const labels = labelsFrom(input.labels);
  const { shop } = input;
  const blocks: Block[] = [];
  pushShopHeader(
    blocks,
    shop,
    paper.charsPerLine,
    labels,
    settings.printLogo !== false,
  );
  blocks.push({ t: 'rule', char: '=' });
  pushCenter(blocks, labels.voidTitle, {
    bold: true,
    size: shopNameSize(labels.voidTitle, paper.charsPerLine),
  });
  blocks.push({ t: 'rule', char: '=' });
  pushPair(blocks, labels.originalBill, input.originalInvoiceNo);
  pushPair(
    blocks,
    labels.originalDate,
    formatReceiptDate(input.originalCreatedAt, shop.timeZone),
  );
  pushPair(
    blocks,
    labels.date,
    formatReceiptDate(input.voidCreatedAt, shop.timeZone),
  );
  const staff = input.staffName?.trim() ?? '';
  if (shop.showCashierOnReceipt && staff.length > 0)
    pushPair(blocks, labels.cashier, staff);
  pushPair(blocks, labels.reason, input.reason.trim());
  if (input.replacementInvoiceNo)
    pushPair(blocks, labels.replacementBill, input.replacementInvoiceNo);
  const footer = shop.receiptFooter.trim();
  if (footer.length > 0) {
    blocks.push({ t: 'rule', char: '-' });
    pushCenter(blocks, footer);
  }
  pushPoweredBy(blocks);
  pushJobEnd(blocks, false);
  return blocks;
}
