import type { Align, Block, TextSize } from './types.ts';

export type PaperMm = 44 | 58 | 76 | 80 | 112;

export type ItemLayout = 'columns' | 'stacked';

export type PaperPreset = {
  mm: PaperMm;
  charsPerLine: number;
  dots: number;
  bytesPerRow: number;
};

/** 06 §2. 80 mm is the default. 44/76/112 are advanced presets. */
export const PAPER_PRESETS: Record<PaperMm, PaperPreset> = {
  44: { mm: 44, charsPerLine: 24, dots: 288, bytesPerRow: 36 },
  58: { mm: 58, charsPerLine: 32, dots: 384, bytesPerRow: 48 },
  76: { mm: 76, charsPerLine: 40, dots: 512, bytesPerRow: 64 },
  80: { mm: 80, charsPerLine: 48, dots: 576, bytesPerRow: 72 },
  112: { mm: 112, charsPerLine: 69, dots: 832, bytesPerRow: 104 },
};

export type ResolvedPaper = {
  paperMm: PaperMm;
  charsPerLine: number;
  dots: number;
  bytesPerRow: number;
  itemLayout: ItemLayout;
};

/**
 * 58 mm and 44 mm always use the two-line item layout.
 * Anything under 40 columns does too (a 32-column override on 80 mm paper).
 * 40 and above use name / qty / amount columns.
 */
export function itemLayoutFor(
  charsPerLine: number,
  paperMm: PaperMm,
): ItemLayout {
  if (paperMm === 44 || paperMm === 58) {
    return 'stacked';
  }
  if (charsPerLine < 40) {
    return 'stacked';
  }
  return 'columns';
}

export function resolvePaper(
  input: { paperMm?: PaperMm; charsPerLine?: number; dots?: number } = {},
): ResolvedPaper {
  const paperMm = input.paperMm ?? 80;
  const preset = PAPER_PRESETS[paperMm];
  const charsPerLine = input.charsPerLine ?? preset.charsPerLine;
  const dots = input.dots ?? preset.dots;
  if (!Number.isInteger(charsPerLine) || charsPerLine < 1) {
    throw new Error('charsPerLine must be a positive integer');
  }
  if (!Number.isInteger(dots) || dots < 1) {
    throw new Error('dots must be a positive integer');
  }
  return {
    paperMm,
    charsPerLine,
    dots,
    bytesPerRow: Math.ceil(dots / 8),
    itemLayout: itemLayoutFor(charsPerLine, paperMm),
  };
}

/** `1234567890` repeated and cut to exactly `charsPerLine`. */
export function paperRuler(charsPerLine: number): string {
  if (!Number.isInteger(charsPerLine) || charsPerLine < 1) {
    throw new Error('charsPerLine must be a positive integer');
  }
  const unit = '1234567890';
  let ruler = '';
  while (ruler.length < charsPerLine) {
    ruler += unit;
  }
  return ruler.slice(0, charsPerLine);
}

export function hasNonAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if ((text.charCodeAt(i) ?? 0) > 127) {
      return true;
    }
  }
  return false;
}

const RTL_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;

export function lineNeedsRtl(text: string): boolean {
  return RTL_RE.test(text);
}

/**
 * Word-wrap. A token longer than `width` is hard-broken.
 * Spaces used as the break are not kept.
 */
export function wrapText(text: string, width: number): string[] {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error('width must be a positive integer');
  }
  if (text.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const breakAt = rest.lastIndexOf(' ', width);
    if (breakAt <= 0) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
      continue;
    }
    const piece = rest.slice(0, breakAt).trimEnd();
    rest = rest.slice(breakAt + 1).trimStart();
    if (piece.length > 0) {
      lines.push(piece);
    }
  }
  if (rest.length > 0) {
    lines.push(rest);
  }
  return lines;
}

function limitWrappedLines(
  lines: string[],
  maxLines: number,
  width: number,
): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines);
  const ellipsis = '...';
  const lastIndex = maxLines - 1;
  const last = kept[lastIndex] ?? '';
  const room = width - ellipsis.length;
  const base = last.length > room ? last.slice(0, room) : last;
  kept[lastIndex] = `${base}${ellipsis}`;
  return kept;
}

function rightAlign(text: string, width: number): string[] {
  return wrapText(text, width).map((line) =>
    line.length >= width ? line : `${' '.repeat(width - line.length)}${line}`,
  );
}

/**
 * Label at the left, value at the right, at least one space between.
 * If they do not fit, the value goes on the next line, right-aligned.
 */
export function formatPair(
  left: string,
  right: string,
  width: number,
): string[] {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error('width must be a positive integer');
  }
  if (right.length === 0) {
    return wrapText(left, width);
  }
  if (left.length === 0) {
    return rightAlign(right, width);
  }
  if (left.length + 1 + right.length <= width) {
    const gap = width - left.length - right.length;
    return [`${left}${' '.repeat(gap)}${right}`];
  }
  return [...wrapText(left, width), ...rightAlign(right, width)];
}

/** Columns: qty is 5, amount is 15, the name takes the rest. 48 → 28/5/15. */
export function columnWidths(charsPerLine: number): {
  name: number;
  qty: number;
  amount: number;
} {
  if (!Number.isInteger(charsPerLine) || charsPerLine < 20) {
    throw new Error('column layout needs at least 20 characters per line');
  }
  const qty = 5;
  const amount = 15;
  return { name: charsPerLine - qty - amount, qty, amount };
}

function padEnd(text: string, width: number): string {
  if (text.length === width) {
    return text;
  }
  if (text.length > width) {
    return text.slice(0, width);
  }
  return text + ' '.repeat(width - text.length);
}

function fitEnd(text: string, width: number): string {
  if (text.length === width) {
    return text;
  }
  if (text.length > width) {
    return text.slice(text.length - width);
  }
  return ' '.repeat(width - text.length) + text;
}

export function formatColumnHeader(
  labels: { item: string; qty: string; amount: string },
  charsPerLine: number,
): string {
  const widths = columnWidths(charsPerLine);
  return (
    padEnd(labels.item, widths.name) +
    fitEnd(labels.qty, widths.qty) +
    fitEnd(labels.amount, widths.amount)
  );
}

export type ItemFields = {
  name: string;
  qty: string;
  amount: string;
  detail?: string;
  breakdown?: string;
};

/**
 * Columns: name in the left column (max 2 lines), qty and amount on the first line.
 * Stacked (58 mm): name lines, then `breakdown` (or the qty) on the left and the amount on the right.
 */
export function formatItemLines(
  item: ItemFields,
  charsPerLine: number,
  mode: ItemLayout,
): string[] {
  if (!Number.isInteger(charsPerLine) || charsPerLine < 1) {
    throw new Error('charsPerLine must be a positive integer');
  }
  if (mode === 'stacked') {
    const lines = wrapText(item.name, charsPerLine);
    const left = item.breakdown ?? ` ${item.qty}`;
    lines.push(...formatPair(left, item.amount, charsPerLine));
    return lines;
  }
  const widths = columnWidths(charsPerLine);
  const wrapped =
    item.name.length === 0 ? [''] : wrapText(item.name, widths.name);
  const names = limitWrappedLines(wrapped, 2, widths.name);
  const lines: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const nameLine = names[index] ?? '';
    if (index === 0) {
      lines.push(
        padEnd(nameLine, widths.name) +
          fitEnd(item.qty, widths.qty) +
          fitEnd(item.amount, widths.amount),
      );
      continue;
    }
    if (nameLine.length > 0) {
      lines.push(nameLine);
    }
  }
  if (item.detail !== undefined && item.detail.length > 0) {
    const detailWidth = Math.max(1, charsPerLine - 2);
    for (const detailLine of wrapText(item.detail, detailWidth)) {
      lines.push(`  ${detailLine}`);
    }
  }
  return lines;
}

export type LayoutOptions = {
  charsPerLine: number;
  itemLayout: ItemLayout;
};

export type LaidText = {
  kind: 'text';
  text: string;
  align: Align;
  bold: boolean;
  size: TextSize;
};

export type LaidCommand =
  | LaidText
  | { kind: 'logo' }
  | { kind: 'image'; source: Block & { t: 'image' } }
  | { kind: 'qr'; data: string }
  | { kind: 'feed'; lines: number }
  | { kind: 'cut' }
  | { kind: 'drawer' };

function pushText(
  out: LaidCommand[],
  text: string,
  align: Align,
  bold: boolean,
  size: TextSize,
  charsPerLine: number,
): void {
  const paragraphs = text.split('\n');
  const width =
    size === 'double'
      ? Math.max(1, Math.floor(charsPerLine / 2))
      : charsPerLine;
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      continue;
    }
    // Nastaliq width is not the code-unit count. Hand the whole line to the renderer.
    if (hasNonAscii(paragraph)) {
      out.push({ kind: 'text', text: paragraph, align, bold, size });
      continue;
    }
    for (const line of wrapText(paragraph, width)) {
      out.push({ kind: 'text', text: line, align, bold, size });
    }
  }
}

function pushBlock(
  out: LaidCommand[],
  block: Block,
  options: LayoutOptions,
): void {
  switch (block.t) {
    case 'logo':
      out.push({ kind: 'logo' });
      return;
    case 'text':
      pushText(
        out,
        block.text,
        block.align ?? 'left',
        block.bold ?? false,
        block.size ?? 'normal',
        options.charsPerLine,
      );
      return;
    case 'pair': {
      const size = block.size ?? 'normal';
      const width =
        size === 'double'
          ? Math.max(1, Math.floor(options.charsPerLine / 2))
          : options.charsPerLine;
      for (const line of formatPair(block.left, block.right, width)) {
        out.push({
          kind: 'text',
          text: line,
          align: 'left',
          bold: block.bold ?? false,
          size,
        });
      }
      return;
    }
    case 'item': {
      const lines = formatItemLines(
        block,
        options.charsPerLine,
        options.itemLayout,
      );
      for (const line of lines) {
        out.push({
          kind: 'text',
          text: line,
          align: 'left',
          bold: false,
          size: 'normal',
        });
      }
      return;
    }
    case 'rule': {
      const char: string = block.char;
      if (char !== '-' && char !== '=') {
        throw new Error('rule character must be - or =');
      }
      out.push({
        kind: 'text',
        text: char.repeat(options.charsPerLine),
        align: 'left',
        bold: false,
        size: 'normal',
      });
      return;
    }
    case 'image':
      out.push({ kind: 'image', source: block });
      return;
    case 'qr':
      if (block.data.length > 0) {
        out.push({ kind: 'qr', data: block.data });
      }
      return;
    case 'feed':
      if (!Number.isInteger(block.lines) || block.lines < 0) {
        throw new Error('feed lines must be a non-negative integer');
      }
      if (block.lines > 0) {
        out.push({ kind: 'feed', lines: block.lines });
      }
      return;
    case 'cut':
      out.push({ kind: 'cut' });
      return;
    case 'drawer':
      out.push({ kind: 'drawer' });
      return;
    default: {
      const unreachable: never = block;
      throw new Error(`unknown block ${JSON.stringify(unreachable)}`);
    }
  }
}

export function layOut(blocks: Block[], options: LayoutOptions): LaidCommand[] {
  if (!Number.isInteger(options.charsPerLine) || options.charsPerLine < 1) {
    throw new Error('charsPerLine must be a positive integer');
  }
  const out: LaidCommand[] = [];
  for (const block of blocks) {
    pushBlock(out, block, options);
  }
  return out;
}

function visibleLine(text: string, align: Align, width: number): string {
  if (text.length >= width) {
    return text;
  }
  const gap = width - text.length;
  if (align === 'right') {
    return `${' '.repeat(gap)}${text}`;
  }
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return `${' '.repeat(left)}${text}${' '.repeat(gap - left)}`;
  }
  return `${text}${' '.repeat(gap)}`;
}

/** Monospace preview. Every text line is padded to `charsPerLine`. */
export function renderReceiptText(
  blocks: Block[],
  options: LayoutOptions,
): string {
  const lines: string[] = [];
  for (const command of layOut(blocks, options)) {
    if (command.kind !== 'text') {
      continue;
    }
    lines.push(visibleLine(command.text, command.align, options.charsPerLine));
  }
  if (lines.length === 0) {
    return '';
  }
  return `${lines.join('\n')}\n`;
}
