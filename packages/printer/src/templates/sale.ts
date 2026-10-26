import {
  calendarDaysBetween,
  fill,
  formatIsoDate,
  formatItemCount,
  formatReceiptDate,
  formatReceiptMoney,
  formatReceiptNumber,
  formatTaxRate,
} from '../format.ts';
import { formatColumnHeader, resolvePaper } from '../layout.ts';
import type { Block } from '../types.ts';
import {
  labelsFrom,
  pushCenter,
  pushFooter,
  pushJobEnd,
  pushPair,
  pushShopHeader,
  subtotalLabel,
  type TemplateSettings,
} from './common.ts';
import type {
  ReceiptLabels,
  ReceiptLine,
  ReceiptPayment,
  ReceiptSale,
  ReceiptShop,
} from './types.ts';

export type SaleReceiptInput = {
  shop: ReceiptShop;
  sale: ReceiptSale;
  lines: ReceiptLine[];
  payments: ReceiptPayment[];
  staffName: string | null;
  labels?: Partial<ReceiptLabels>;
};

function methodLabel(payment: ReceiptPayment, labels: ReceiptLabels): string {
  const base =
    payment.method === 'cash'
      ? labels.cash
      : payment.method === 'card'
        ? labels.card
        : labels.bankWallet;
  const reference = payment.reference?.trim() ?? '';
  return reference.length > 0 ? `${base} ${reference}` : base;
}

function warrantyText(
  line: ReceiptLine,
  businessDate: string,
  labels: ReceiptLabels,
): string | null {
  if (line.warrantyUntil === null || line.warrantyUntil.trim().length === 0) {
    return null;
  }
  const until = line.warrantyUntil.trim();
  const days = calendarDaysBetween(businessDate, until);
  const template = days === 1 ? labels.warrantyOne : labels.warrantyMany;
  return fill(template, {
    name: line.name.trim(),
    days: String(days),
    date: formatIsoDate(until),
  });
}

function pushItems(
  blocks: Block[],
  lines: ReceiptLine[],
  shop: ReceiptShop,
  labels: ReceiptLabels,
  charsPerLine: number,
  layout: 'columns' | 'stacked',
): void {
  if (layout === 'columns') {
    blocks.push({
      t: 'text',
      text: formatColumnHeader(labels, charsPerLine),
    });
  }
  const money = (paisa: number): string =>
    formatReceiptMoney(paisa, shop.numberGrouping);
  for (const line of lines) {
    const qty = formatItemCount(line.qtyMilli);
    const unitNumber = formatReceiptNumber(line.unitPrice, shop.numberGrouping);
    const discount =
      line.discount > 0
        ? ` -${formatReceiptNumber(line.discount, shop.numberGrouping)}`
        : '';
    const showDetail = line.discount > 0 || line.qtyMilli !== 1000;
    const detail = showDetail
      ? `${money(line.unitPrice)} ${labels.each}${
          line.discount > 0 ? ` - ${labels.less} ${money(line.discount)}` : ''
        }`
      : undefined;
    blocks.push({
      t: 'item',
      name: line.name.trim(),
      qty,
      amount: money(line.net),
      breakdown: ` ${qty} x ${unitNumber}${discount}`,
      detail,
    });
  }
}

function pushPayments(
  blocks: Block[],
  sale: ReceiptSale,
  payments: ReceiptPayment[],
  labels: ReceiptLabels,
  layout: 'columns' | 'stacked',
  grouping: ReceiptShop['numberGrouping'],
): void {
  const money = (paisa: number): string => formatReceiptMoney(paisa, grouping);
  let cashMeta = false;
  for (const payment of payments) {
    pushPair(blocks, methodLabel(payment, labels), money(payment.amount));
    if (payment.method === 'cash' && !cashMeta) {
      cashMeta = true;
      const tender =
        layout === 'stacked' ? labels.tenderedShort : labels.amountTendered;
      pushPair(blocks, tender, money(sale.cashTendered));
      pushPair(blocks, labels.change, money(sale.changeGiven));
    }
  }
  if (sale.udhaarAmount > 0) {
    pushPair(blocks, labels.udhaar, money(sale.udhaarAmount));
    if (sale.khataBalancePaisa !== null) {
      pushPair(blocks, labels.khataBalance, money(sale.khataBalancePaisa));
    }
  }
}

/** Sale receipt blocks for the resolved paper width. */
export function buildSaleReceipt(
  input: SaleReceiptInput,
  settings: TemplateSettings = {},
): Block[] {
  const paper = resolvePaper(settings);
  const labels = labelsFrom(input.labels);
  const { shop, sale } = input;
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
  pushCenter(blocks, labels.saleTitle);
  if (sale.reprint === true) {
    pushCenter(blocks, labels.reprint);
  }
  blocks.push({ t: 'rule', char: '-' });
  pushPair(blocks, labels.bill, sale.invoiceNo);
  pushPair(
    blocks,
    labels.date,
    formatReceiptDate(sale.createdAt, shop.timeZone),
  );
  const staff = input.staffName?.trim() ?? '';
  if (shop.showCashierOnReceipt && staff.length > 0) {
    pushPair(blocks, labels.cashier, staff);
  }
  const customer = sale.customerName?.trim() ?? '';
  if (customer.length > 0) {
    pushPair(blocks, labels.customer, customer);
  }
  blocks.push({ t: 'rule', char: '-' });
  pushItems(
    blocks,
    input.lines,
    shop,
    labels,
    paper.charsPerLine,
    paper.itemLayout,
  );
  blocks.push({ t: 'rule', char: '-' });
  pushPair(
    blocks,
    subtotalLabel(
      formatItemCount(sale.itemsQtyMilli),
      paper.itemLayout,
      labels,
    ),
    money(sale.subtotal),
  );
  if (sale.billDiscount > 0) {
    pushPair(blocks, labels.discount, money(-sale.billDiscount));
  }
  if (!sale.taxInclusive && sale.taxRateBp > 0) {
    pushPair(
      blocks,
      fill(labels.salesTax, {
        label: shop.taxLabel,
        rate: formatTaxRate(sale.taxRateBp),
      }),
      money(sale.tax),
    );
  }
  if (sale.rounding !== 0) {
    pushPair(blocks, labels.rounding, money(sale.rounding));
  }
  blocks.push({ t: 'rule', char: '=' });
  pushPair(blocks, labels.total, money(sale.total), {
    bold: true,
    size: 'double-height',
  });
  blocks.push({ t: 'rule', char: '=' });
  if (sale.taxInclusive && sale.tax > 0) {
    pushPair(
      blocks,
      fill(labels.includesTax, {
        label: shop.taxLabel,
        rate: formatTaxRate(sale.taxRateBp),
      }),
      money(sale.tax),
    );
  }
  if (shop.showPaymentDetails) {
    pushPayments(
      blocks,
      sale,
      input.payments,
      labels,
      paper.itemLayout,
      shop.numberGrouping,
    );
  }
  const saved = sale.itemDiscountTotal + sale.billDiscount;
  if (shop.showYouSaved && saved > 0) {
    pushPair(blocks, labels.youSaved, money(saved));
  }
  const warranties: string[] = [];
  if (shop.printWarranty) {
    for (const line of input.lines) {
      const text = warrantyText(line, sale.businessDate, labels);
      if (text !== null) {
        warranties.push(text);
      }
    }
  }
  const footer = shop.receiptFooter.trim();
  if (warranties.length > 0) {
    blocks.push({ t: 'rule', char: '-' });
    for (const text of warranties) {
      blocks.push({ t: 'text', text });
    }
    blocks.push({ t: 'rule', char: '-' });
  } else if (footer.length > 0) {
    blocks.push({ t: 'rule', char: '-' });
  }
  pushFooter(blocks, footer);
  if (settings.qr === true && sale.id.trim().length > 0) {
    blocks.push({ t: 'qr', data: sale.id.trim() });
  }
  const cash = input.payments.some(
    (payment) => payment.method === 'cash' && payment.amount > 0,
  );
  pushJobEnd(blocks, settings.drawer !== false && cash);
  return blocks;
}
