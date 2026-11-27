import { fill, formatReceiptPhone } from '../format.ts';
import type { Block, TextSize } from '../types.ts';
import { resolveLabels } from './labels.ts';
import type { ReceiptLabels, ReceiptLine, ReceiptShop } from './types.ts';

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
  if (printLogo && shop.showLogo !== false) {
    blocks.push({ t: 'logo' });
  }
  const name = shop.showShopName === false ? '' : shop.name.trim();
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

/** D-085: the last line of every receipt (sale, refund; thermal and window.print), in Font B. Exact text, not translated. */
export const POWERED_BY = 'Powered by AlgoVyn';

export function pushPoweredBy(blocks: Block[]): void {
  blocks.push({ t: 'text', text: POWERED_BY, align: 'center', size: 'small' });
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

/**
 * One bundle component row (06 §4.2 / D-229). At 40+ columns the quantity sits
 * in the qty column and the amount column stays blank; a stacked 58 mm receipt
 * has no columns, so the line must read `  <name> x <qty>` instead of leaving a
 * bare unlabeled quantity on its own line.
 */
export function pushBundleComponent(
  blocks: Block[],
  name: string,
  qty: string,
  layout: 'columns' | 'stacked',
): void {
  if (layout === 'stacked') {
    blocks.push({
      t: 'item',
      name: `  ${name.trim()} x ${qty}`,
      qty: '',
      amount: '',
      breakdown: '',
    });
    return;
  }
  blocks.push({
    t: 'item',
    name: `  ${name.trim()}`,
    qty,
    amount: '',
    breakdown: ` ${qty}`,
  });
}

export function labelsFrom(partial?: Partial<ReceiptLabels>): ReceiptLabels {
  return resolveLabels(partial);
}

/**
 * Group bundle component lines once. A sale with N lines and B bundles used to
 * scan all N lines for every bundle group (O(N×B)); the renderers now look the
 * group up directly, preserving the original line order inside each group.
 */
export function bundleLinesByGroup(
  lines: ReceiptLine[],
): Map<string, ReceiptLine[]> {
  const groups = new Map<string, ReceiptLine[]>();
  for (const line of lines) {
    const key = line.bundleGroup;
    if (!key) continue;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [line]);
    } else {
      group.push(line);
    }
  }
  return groups;
}
