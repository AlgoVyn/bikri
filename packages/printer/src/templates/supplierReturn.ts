import { formatReceiptDate, formatReceiptMoney } from '../format.ts';
import { resolvePaper } from '../layout.ts';
import type { Block } from '../types.ts';
import {
  labelsFrom,
  pushCenter,
  pushJobEnd,
  pushPair,
  pushShopHeader,
  shopNameSize,
  type TemplateSettings,
} from './common.ts';
import type { SupplierReturnLabels, SupplierReturnReceipt } from './types.ts';

const DEFAULTS: SupplierReturnLabels = {
  title: 'RETURN TO SUPPLIER',
  supplier: 'Supplier',
  delivery: 'Delivery',
  date: 'Date',
  total: 'Total credit',
  received: 'Money received',
  reason: 'Reason',
  note: 'Note',
  balance: 'You owe now',
  advance: 'Advance with supplier',
  methodCash: 'Cash',
  methodBank: 'Bank/wallet',
};

/** Return-to-supplier slip (screens/13); no customer-receipt branding. */
export function buildSupplierReturn(
  input: SupplierReturnReceipt,
  settings: TemplateSettings = {},
): Block[] {
  const paper = resolvePaper(settings);
  const shop = input.shop;
  const labels = { ...DEFAULTS, ...(input.labels ?? {}) };
  const money = (paisa: number): string =>
    formatReceiptMoney(paisa, shop.numberGrouping);
  const blocks: Block[] = [];
  pushShopHeader(
    blocks,
    shop,
    paper.charsPerLine,
    labelsFrom(),
    settings.printLogo !== false,
  );
  blocks.push({ t: 'rule', char: '=' });
  blocks.push({
    t: 'text',
    text: labels.title,
    align: 'center',
    bold: true,
    size: shopNameSize(labels.title, paper.charsPerLine),
  });
  blocks.push({ t: 'rule', char: '=' });
  pushPair(blocks, labels.supplier, input.supplierName);
  if (input.purchaseInvoice)
    pushPair(blocks, labels.delivery, input.purchaseInvoice);
  pushPair(blocks, labels.date, input.businessDate);
  blocks.push({ t: 'rule', char: '-' });
  for (const line of input.lines) {
    pushPair(blocks, `${line.qty} x ${line.name}`, money(line.lineTotal));
    pushPair(blocks, `  @ ${money(line.unitCredit)}`, '');
  }
  blocks.push({ t: 'rule', char: '-' });
  pushPair(blocks, labels.total, money(input.total), { bold: true });
  if (input.refundReceived > 0) {
    pushPair(blocks, labels.received, money(input.refundReceived));
    if (input.refundMethod)
      pushPair(
        blocks,
        '',
        input.refundMethod === 'cash' ? labels.methodCash : labels.methodBank,
      );
  }
  pushPair(
    blocks,
    input.balanceAfter < 0 ? labels.advance : labels.balance,
    money(Math.abs(input.balanceAfter)),
    { bold: true },
  );
  blocks.push({ t: 'rule', char: '-' });
  pushCenter(blocks, `${labels.reason}: ${input.reason}`);
  if (input.note.trim() !== '')
    pushCenter(blocks, `${labels.note}: ${input.note.trim()}`);
  pushJobEnd(blocks, false);
  return blocks;
}
