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
import type { DayCloseLabels, DayCloseReceipt } from './types.ts';

const DEFAULTS: DayCloseLabels = {
  title: 'DAY CLOSE',
  device: 'Device',
  from: 'From',
  to: 'To',
  opening: 'Opening cash',
  cashSales: 'Cash sales',
  udhaarIn: 'Udhaar received (cash)',
  payIns: 'Cash put in',
  supplierIn: 'Refunds from suppliers (cash)',
  cashRefunds: 'Refunds & cancelled bills (cash)',
  cashExpenses: 'Cash expenses',
  supplierOut: 'Paid to suppliers (cash)',
  payOuts: 'Cash taken out',
  expected: 'Expected in drawer',
  counted: 'Counted',
  difference: 'Difference',
  correct: 'Drawer is correct',
  short: 'Short',
  over: 'Over',
  card: 'Card total',
  bank: 'Bank/wallet total',
  udhaarGiven: 'Udhaar given',
  bills: 'Bills',
  refunds: 'Refunds',
  note: 'Note',
  closedBy: 'Closed by',
};

/** Day close / Z-report (screens/15 AC 7). Internal slip: no Powered by AlgoVyn line. */
export function buildDayClose(
  input: DayCloseReceipt,
  settings: TemplateSettings = {},
): Block[] {
  const paper = resolvePaper(settings);
  const shop = input.shop;
  const labels = { ...DEFAULTS, ...(input.labels ?? {}) };
  const money = (paisa: number): string =>
    formatReceiptMoney(paisa, shop.numberGrouping);
  const blocks: Block[] = [];
  // The shared shop header uses receipt labels; only the shop fields are needed here.
  const receiptLabels = labelsFrom();
  pushShopHeader(
    blocks,
    shop,
    paper.charsPerLine,
    receiptLabels,
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
  pushPair(blocks, labels.device, input.deviceName);
  pushPair(
    blocks,
    labels.from,
    formatReceiptDate(input.periodStart, shop.timeZone),
  );
  pushPair(
    blocks,
    labels.to,
    formatReceiptDate(input.periodEnd, shop.timeZone),
  );
  blocks.push({ t: 'rule', char: '-' });
  pushPair(blocks, labels.opening, money(input.openingCash));
  pushPair(blocks, `+ ${labels.cashSales}`, money(input.cashSales));
  pushPair(blocks, `+ ${labels.udhaarIn}`, money(input.udhaarCashIn));
  pushPair(blocks, `+ ${labels.payIns}`, money(input.payIns));
  pushPair(blocks, `+ ${labels.supplierIn}`, money(input.supplierCashIn));
  pushPair(blocks, `- ${labels.cashRefunds}`, money(input.cashRefunds));
  pushPair(blocks, `- ${labels.cashExpenses}`, money(input.cashExpenses));
  pushPair(blocks, `- ${labels.supplierOut}`, money(input.supplierCashOut));
  pushPair(blocks, `- ${labels.payOuts}`, money(input.payOuts));
  blocks.push({ t: 'rule', char: '-' });
  pushPair(blocks, labels.expected, money(input.expectedCash), { bold: true });
  pushPair(blocks, labels.counted, money(input.countedCash));
  const state =
    input.difference === 0
      ? labels.correct
      : `${input.difference < 0 ? labels.short : labels.over} ${money(Math.abs(input.difference))}`;
  pushPair(blocks, labels.difference, state, { bold: true });
  blocks.push({ t: 'rule', char: '-' });
  pushPair(blocks, labels.card, money(input.cardTotal));
  pushPair(blocks, labels.bank, money(input.bankTotal));
  pushPair(blocks, labels.udhaarGiven, money(input.udhaarGiven));
  pushPair(blocks, labels.bills, String(input.bills));
  pushPair(blocks, labels.refunds, String(input.refunds));
  if (input.note.trim() !== '') {
    blocks.push({ t: 'rule', char: '-' });
    pushCenter(blocks, `${labels.note}: ${input.note.trim()}`);
  }
  const staff = input.staffName?.trim() ?? '';
  if (staff !== '') pushPair(blocks, labels.closedBy, staff);
  pushJobEnd(blocks, false);
  return blocks;
}
