import {
  formatItemCount,
  formatReceiptDate,
  formatReceiptMoney,
} from '../format.ts';
import { formatColumnHeader, resolvePaper } from '../layout.ts';
import type { Block } from '../types.ts';
import {
  labelsFrom,
  pushCenter,
  pushFooter,
  pushJobEnd,
  pushPair,
  pushPoweredBy,
  pushShopHeader,
  type TemplateSettings,
} from './common.ts';
import type { ReceiptLabels, RefundReceipt } from './types.ts';

function methodName(
  method: RefundReceipt['method'],
  labels: ReceiptLabels,
): string {
  if (method === 'cash') {
    return labels.cash;
  }
  if (method === 'card') {
    return labels.card;
  }
  if (method === 'bank_wallet') {
    return labels.bankWallet;
  }
  return labels.paidBack;
}

/** Refund receipt. Drawer kicks only when cash is handed back. */
export function buildRefundReceipt(
  input: RefundReceipt & { labels?: Partial<ReceiptLabels> },
  settings: TemplateSettings = {},
): Block[] {
  const paper = resolvePaper(settings);
  const labels = labelsFrom(input.labels);
  const { shop } = input;
  const money = (paisa: number): string =>
    formatReceiptMoney(paisa, shop.numberGrouping);
  const blocks: Block[] = [];
  pushShopHeader(
    blocks,
    shop,
    paper.charsPerLine,
    labels,
    settings.printLogo !== false,
  );
  blocks.push({ t: 'rule', char: '-' });
  pushCenter(blocks, labels.refundTitle);
  blocks.push({ t: 'rule', char: '-' });
  pushPair(blocks, labels.originalBill, input.originalInvoiceNo);
  pushPair(
    blocks,
    labels.originalDate,
    formatReceiptDate(input.originalCreatedAt, shop.timeZone),
  );
  pushPair(
    blocks,
    labels.date,
    formatReceiptDate(input.refundCreatedAt, shop.timeZone),
  );
  const staff = input.staffName?.trim() ?? '';
  if (shop.showCashierOnReceipt && staff.length > 0) {
    pushPair(blocks, labels.cashier, staff);
  }
  const customer = input.customerName?.trim() ?? '';
  if (customer.length > 0) {
    pushPair(blocks, labels.customer, customer);
  }
  blocks.push({ t: 'rule', char: '-' });
  if (paper.itemLayout === 'columns') {
    blocks.push({
      t: 'text',
      text: formatColumnHeader(labels, paper.charsPerLine),
    });
  }
  for (const line of input.lines) {
    const qty = formatItemCount(line.qtyMilli);
    blocks.push({
      t: 'item',
      name: line.name.trim(),
      qty,
      amount: money(line.amount),
      breakdown: ` ${qty}`,
    });
  }
  blocks.push({ t: 'rule', char: '-' });
  pushPair(blocks, labels.exact, money(input.exactAmount));
  if (input.rounding !== 0) {
    pushPair(blocks, labels.rounding, money(input.rounding));
  }
  if (input.amount > 0) {
    pushPair(blocks, methodName(input.method, labels), money(input.amount), {
      bold: true,
    });
  }
  if (input.udhaarPart > 0) {
    pushPair(blocks, labels.takenOffKhata, money(input.udhaarPart), {
      bold: input.amount === 0,
    });
    if (input.khataBalancePaisa !== null) {
      pushPair(blocks, labels.khataBalance, money(input.khataBalancePaisa));
    }
  }
  pushPair(blocks, labels.reason, input.reason.trim());
  const footer = shop.receiptFooter.trim();
  if (footer.length > 0) {
    blocks.push({ t: 'rule', char: '-' });
    pushFooter(blocks, footer);
  }
  const cashBack = input.method === 'cash' && input.amount > 0;
  pushPoweredBy(blocks);
  pushJobEnd(blocks, settings.drawer !== false && cashBack);
  return blocks;
}
