import {
  fill,
  formatIsoDate,
  formatItemCount,
  formatReceiptDate,
  formatReceiptMoney,
  formatReceiptNumber,
  formatTaxRate,
} from '../format.ts';
import {
  columnHeaderCells,
  formatColumnHeader,
  resolvePaper,
} from '../layout.ts';
import type { Block } from '../types.ts';
import {
  bundleLinesByGroup,
  labelsFrom,
  pushBundleComponent,
  pushCenter,
  pushFooter,
  pushJobEnd,
  pushPair,
  pushPoweredBy,
  pushShopHeader,
  subtotalLabel,
  type TemplateSettings,
} from './common.ts';
import type { ReceiptLabels, ReceiptLine, ReceiptShop } from './types.ts';

export type QuotationReceiptInput = {
  shop: ReceiptShop;
  quote: {
    quoteNo: string;
    createdAt: number;
    businessDate: string;
    validUntil: string;
    customerName: string | null;
    staffName: string | null;
    itemsQtyMilli: number;
    itemDiscountTotal: number;
    subtotal: number;
    billDiscount: number;
    taxRateBp: number;
    tax: number;
    taxInclusive: boolean;
    rounding: number;
    total: number;
    note: string;
  };
  lines: ReceiptLine[];
  labels?: Partial<ReceiptLabels>;
};

function pushQuoteItems(
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
      nowrap: true,
      cells: columnHeaderCells(labels),
    });
  }
  const money = (paisa: number): string =>
    formatReceiptMoney(paisa, shop.numberGrouping);
  const bundleGroups = bundleLinesByGroup(lines);
  const renderedGroups = new Set<string>();
  for (const line of lines) {
    if (line.bundleGroup) {
      if (renderedGroups.has(line.bundleGroup)) continue;
      renderedGroups.add(line.bundleGroup);
      const group = bundleGroups.get(line.bundleGroup) ?? [line];
      const bundleQty = line.bundleQty ?? group[0]?.bundleQty ?? 1;
      const bundleTotal =
        line.bundlePrice != null
          ? line.bundlePrice * bundleQty
          : group.reduce((sum, component) => sum + component.net, 0);
      blocks.push({
        t: 'item',
        name: (line.bundleName ?? '').trim(),
        qty: `${bundleQty}`,
        amount: money(bundleTotal),
        breakdown: ` ${bundleQty}`,
        bold: true,
      });
      for (const component of group) {
        pushBundleComponent(
          blocks,
          component.name,
          formatItemCount(component.qtyMilli),
          layout,
        );
      }
      continue;
    }
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

/** Quotation slip blocks (screens/21, 06 §4.3): not a tax invoice and no payment rows. */
export function buildQuotationReceipt(
  input: QuotationReceiptInput,
  settings: TemplateSettings = {},
): Block[] {
  const paper = resolvePaper(settings);
  const labels = labelsFrom(input.labels);
  const { shop, quote } = input;
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
  pushCenter(blocks, labels.quotationTitle, {
    bold: true,
    size: 'double-height',
  });
  pushCenter(blocks, labels.quotationOnly);
  blocks.push({ t: 'rule', char: '-' });
  pushPair(blocks, labels.quotationNumber, quote.quoteNo);
  pushPair(
    blocks,
    labels.date,
    formatReceiptDate(quote.createdAt, shop.timeZone),
  );
  pushPair(blocks, labels.validUntil, formatIsoDate(quote.validUntil));
  const staff = quote.staffName?.trim() ?? '';
  if (shop.showCashierOnReceipt && staff.length > 0)
    pushPair(blocks, labels.cashier, staff);
  const customer = quote.customerName?.trim() ?? '';
  if (customer.length > 0) pushPair(blocks, labels.customer, customer);
  blocks.push({ t: 'rule', char: '-' });
  pushQuoteItems(
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
      formatItemCount(quote.itemsQtyMilli),
      paper.itemLayout,
      labels,
    ),
    money(quote.subtotal),
  );
  if (quote.billDiscount > 0)
    pushPair(blocks, labels.discount, `-${money(quote.billDiscount)}`);
  if (quote.tax > 0 && !quote.taxInclusive)
    pushPair(
      blocks,
      fill(labels.salesTax, {
        label: shop.taxLabel,
        rate: formatTaxRate(quote.taxRateBp),
      }),
      money(quote.tax),
    );
  if (quote.rounding !== 0)
    pushPair(blocks, labels.rounding, money(quote.rounding));
  blocks.push({ t: 'rule', char: '=' });
  pushPair(blocks, labels.total, money(quote.total), {
    bold: true,
    size: 'double-height',
  });
  if (quote.tax > 0 && quote.taxInclusive)
    pushPair(
      blocks,
      fill(labels.includesTax, {
        label: shop.taxLabel,
        rate: formatTaxRate(quote.taxRateBp),
      }),
      money(quote.tax),
    );
  if (quote.note.trim().length > 0) {
    blocks.push({ t: 'rule', char: '-' });
    blocks.push({
      t: 'text',
      text: `${labels.terms}: ${quote.note.trim()}`,
      align: 'left',
    });
  }
  blocks.push({ t: 'rule', char: '-' });
  pushCenter(blocks, labels.quotationOnly);
  pushCenter(
    blocks,
    fill(labels.pricesValidUntil, { date: formatIsoDate(quote.validUntil) }),
  );
  pushFooter(blocks, shop.receiptFooter);
  pushPoweredBy(blocks);
  pushJobEnd(blocks, false);
  return blocks;
}
