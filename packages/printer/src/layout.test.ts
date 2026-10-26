import { describe, expect, it } from 'vitest';
import {
  columnWidths,
  formatColumnHeader,
  formatItemLines,
  formatPair,
  itemLayoutFor,
  layOut,
  paperRuler,
  renderReceiptText,
  resolvePaper,
  wrapText,
} from './layout.ts';

// 06 §10 layout.test.ts: long names wrap, amounts right-align, pair overflow, 24/32/40/42/48/69 widths.

const WIDTHS = [24, 32, 40, 42, 48, 69] as const;

describe('wrapText', () => {
  it('breaks on spaces and hard-breaks long tokens', () => {
    expect(wrapText('USB-C cable 1m braided', 10)).toEqual([
      'USB-C',
      'cable 1m',
      'braided',
    ]);
    expect(wrapText('ABCDEFGHIJKL', 5)).toEqual(['ABCDE', 'FGHIJ', 'KL']);
    expect(wrapText('', 5)).toEqual([]);
    expect(() => wrapText('x', 0)).toThrow();
  });
});

describe('formatPair', () => {
  it.each(WIDTHS)('right-aligns the value at %i columns', (w) => {
    const [line] = formatPair('TOTAL', 'Rs 40,400', w);
    expect(line).toHaveLength(w);
    expect(line?.startsWith('TOTAL ')).toBe(true);
    expect(line?.endsWith('Rs 40,400')).toBe(true);
  });

  it('moves the value to the next line, right-aligned, when it does not fit', () => {
    expect(
      formatPair('Customer', 'Muhammad Bilal Hussain Qureshi', 32),
    ).toEqual(['Customer', '  Muhammad Bilal Hussain Qureshi']);
    expect(formatPair('', 'Rs 5', 8)).toEqual(['    Rs 5']);
    expect(formatPair('Only label', '', 8)).toEqual(['Only', 'label']);
  });
});

describe('item columns (06 §4.1)', () => {
  it('uses name 1–28, qty 29–33, amount 34–48 at 48 columns', () => {
    expect(columnWidths(48)).toEqual({ name: 28, qty: 5, amount: 15 });
    const header = formatColumnHeader(
      { item: 'ITEM', qty: 'QTY', amount: 'AMOUNT' },
      48,
    );
    expect(header).toHaveLength(48);
    expect(header.slice(30, 33)).toBe('QTY');
    expect(header.slice(42)).toBe('AMOUNT');
    const [first] = formatItemLines(
      { name: 'USB-C cable 1m', qty: '2', amount: 'Rs 900' },
      48,
      'columns',
    );
    expect(first?.[32]).toBe('2');
    expect(first?.slice(-6)).toBe('Rs 900');
  });

  it('wraps a long name to at most 2 lines and adds the indented detail', () => {
    const lines = formatItemLines(
      {
        name: 'Samsung Galaxy A15 4/128 Blue with official warranty card and box',
        qty: '1',
        amount: 'Rs 40,000',
        detail: 'Rs 42,000 each - less Rs 2,000',
      },
      48,
      'columns',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]?.endsWith('...')).toBe(true);
    expect(lines[1]?.length).toBeLessThanOrEqual(28);
    expect(lines[2]).toBe('  Rs 42,000 each - less Rs 2,000');
  });

  it('stacks name then breakdown/amount at 58 mm (06 §4.2)', () => {
    expect(
      formatItemLines(
        {
          name: 'Samsung A15 4/128 Blue',
          qty: '1',
          amount: 'Rs 40,000',
          breakdown: ' 1 x 42,000 -2,000',
        },
        32,
        'stacked',
      ),
    ).toEqual(['Samsung A15 4/128 Blue', ' 1 x 42,000 -2,000     Rs 40,000']);
  });

  it('chooses stacked below 40 columns and always on 44/58 mm', () => {
    expect(itemLayoutFor(32, 80)).toBe('stacked');
    expect(itemLayoutFor(42, 80)).toBe('columns');
    expect(itemLayoutFor(48, 58)).toBe('stacked');
    expect(
      resolvePaper({ paperMm: 80, charsPerLine: 42, dots: 512 }),
    ).toMatchObject({
      charsPerLine: 42,
      dots: 512,
      bytesPerRow: 64,
      itemLayout: 'columns',
    });
  });
});

describe('every supported width', () => {
  it.each(WIDTHS)('keeps every line within %i columns', (w) => {
    const text = renderReceiptText(
      [
        {
          t: 'text',
          text: 'Algovyn Mobiles and Electronics Hall Road',
          align: 'center',
          size: 'double',
        },
        { t: 'rule', char: '-' },
        { t: 'pair', left: 'Subtotal (3 items)', right: 'Rs 1,23,45,678.90' },
        {
          t: 'item',
          name: 'A very long product name that wraps',
          qty: '12.5',
          amount: 'Rs 12,345.50',
          detail: 'Rs 987.65 each',
        },
        { t: 'text', text: paperRuler(w) },
      ],
      { charsPerLine: w, itemLayout: itemLayoutFor(w, 80) },
    );
    for (const line of text.trimEnd().split('\n')) {
      expect(line.length, line).toBeLessThanOrEqual(w);
    }
    expect(text).toContain(paperRuler(w));
    expect(paperRuler(w)).toHaveLength(w);
  });

  it('halves the width for double-size text', () => {
    const laid = layOut(
      [{ t: 'text', text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', size: 'double' }],
      {
        charsPerLine: 32,
        itemLayout: 'stacked',
      },
    );
    expect(laid.map((c) => (c.kind === 'text' ? c.text : ''))).toEqual([
      'ABCDEFGHIJKLMNOP',
      'QRSTUVWXYZ',
    ]);
  });

  it('rejects bad feed counts and widths', () => {
    expect(() =>
      layOut([{ t: 'feed', lines: -1 }], {
        charsPerLine: 32,
        itemLayout: 'stacked',
      }),
    ).toThrow();
    expect(() =>
      layOut([], { charsPerLine: 0, itemLayout: 'stacked' }),
    ).toThrow();
  });
});
