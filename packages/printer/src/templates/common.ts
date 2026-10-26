import { fill, formatReceiptPhone } from '../format.ts';
import type { Block, TextSize } from '../types.ts';
import { resolveLabels } from './labels.ts';
import type { ReceiptLabels, ReceiptShop } from './types.ts';

export type TemplateSettings = {
  paperMm?: 44 | 58 | 76 | 80 | 112;
  charsPerLine?: number;
  dots?: number;
  /** Default on. The encoder skips the block when no logo bitmap is passed. */
  printLogo?: boolean;
  /** Default off. QR payload is the bill id. */
  qr?: boolean;
  /** Default on for cash. The block is omitted when there is no cash portion. */
  drawer?: boolean;
};

export function pushPair(
  blocks: Block[],
  left: string,
  right: string,
  style?: { bold?: boolean; size?: TextSize },
): void {
  blocks.push({
    t: 'pair',
    left,
    right,
    bold: style?.bold,
    size: style?.size,
  });
}

export function pushCenter(
  blocks: Block[],
  text: string,
  style?: { bold?: boolean; size?: TextSize },
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  blocks.push({
    t: 'text',
    text: trimmed,
    align: 'center',
    bold: style?.bold,
    size: style?.size,
  });
}

export function shopNameSize(name: string, charsPerLine: number): TextSize {
  return name.length * 2 <= charsPerLine ? 'double' : 'double-height';
}

export function pushShopHeader(
  blocks: Block[],
  shop: ReceiptShop,
  charsPerLine: number,
  labels: ReceiptLabels,
  printLogo: boolean,
): void {
  if (printLogo) {
    blocks.push({ t: 'logo' });
  }
  const name = shop.name.trim();
  if (name.length > 0) {
    pushCenter(blocks, name, {
      bold: true,
      size: shopNameSize(name, charsPerLine),
    });
  }
  pushCenter(blocks, shop.address);
  const phone = formatReceiptPhone(shop.phone);
  if (phone.length > 0) {
    pushCenter(blocks, `${labels.telPrefix} ${phone}`);
  }
  const ntn = shop.ntn.trim();
  if (ntn.length > 0) {
    pushCenter(blocks, `${labels.ntn}: ${ntn}`);
  }
  const strn = shop.strn.trim();
  if (strn.length > 0) {
    pushCenter(blocks, `${labels.strn}: ${strn}`);
  }
  pushCenter(blocks, shop.receiptHeader);
}

export function pushFooter(blocks: Block[], footer: string): void {
  const trimmed = footer.trim();
  if (trimmed.length === 0) {
    return;
  }
  pushCenter(blocks, trimmed);
}

export function pushJobEnd(blocks: Block[], drawer: boolean): void {
  blocks.push({ t: 'feed', lines: 3 });
  blocks.push({ t: 'cut' });
  if (drawer) {
    blocks.push({ t: 'drawer' });
  }
}

export function subtotalLabel(
  count: string,
  layout: 'columns' | 'stacked',
  labels: ReceiptLabels,
): string {
  if (layout === 'stacked') {
    return fill(labels.subtotalCount, { n: count });
  }
  const template = count === '1' ? labels.subtotalItem : labels.subtotalItems;
  return fill(template, { n: count });
}

export function labelsFrom(partial?: Partial<ReceiptLabels>): ReceiptLabels {
  return resolveLabels(partial);
}
