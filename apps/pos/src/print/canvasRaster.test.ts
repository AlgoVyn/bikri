import { describe, expect, it } from 'vitest';
import { createCanvasRasterRenderer } from './canvasRaster.ts';
import { fakeCanvasDocument } from './fakeCanvas.ts';

const options = {
  dots: 576,
  charsPerLine: 48,
  align: 'left' as const,
  bold: false,
  size: 'normal' as const,
};

describe('canvas raster cells (PRT-M1)', () => {
  it('draws a mixed Urdu/English item in one LTR column order', () => {
    const { doc, calls } = fakeCanvasDocument();
    const renderer = createCanvasRasterRenderer(doc);
    renderer.renderLine('', {
      ...options,
      rtl: true,
      cells: [
        { text: 'کیبل 1m' },
        { text: '2', align: 'end' },
        { text: 'Rs 900', align: 'end' },
      ],
    });
    expect(calls.map((call) => call.text)).toEqual(['کیبل 1m', '2', 'Rs 900']);
    expect(calls.map((call) => call.x)).toEqual([0, 396, 576]);
    expect(calls.map((call) => call.align)).toEqual(['left', 'right', 'right']);
    // The line is RTL because of the name; qty and amount stay LTR inside
    // their own cells instead of following the line direction.
    expect(calls.map((call) => call.direction)).toEqual(['rtl', 'ltr', 'ltr']);
    // Each cell is capped at its real column, not the full 576-dot paper.
    expect(calls.map((call) => call.maxWidth)).toEqual([336, 60, 180]);
    expect(calls[0]?.font).toContain('Noto Naskh Arabic UI');
    expect(calls[1]?.font).toContain('JetBrains Mono');
  });

  it('keeps the column header order for a fully Urdu row', () => {
    const { doc, calls } = fakeCanvasDocument();
    const renderer = createCanvasRasterRenderer(doc);
    renderer.renderLine('', {
      ...options,
      rtl: true,
      cells: [
        { text: 'چیز' },
        { text: 'تعداد', align: 'end' },
        { text: 'رقم', align: 'end' },
      ],
    });
    expect(calls.map((call) => call.text)).toEqual(['چیز', 'تعداد', 'رقم']);
    expect(calls.map((call) => call.x)).toEqual([0, 396, 576]);
    expect(calls.every((call) => call.direction === 'rtl')).toBe(true);
  });

  it('draws the pair row in start/end order when the label is Urdu', () => {
    const { doc, calls } = fakeCanvasDocument();
    const renderer = createCanvasRasterRenderer(doc);
    renderer.renderLine('', {
      ...options,
      rtl: true,
      cells: [{ text: 'کل بیلنس' }, { text: 'Rs 1,250', align: 'end' }],
    });
    expect(calls.map((call) => call.text)).toEqual(['کل بیلنس', 'Rs 1,250']);
    expect(calls.map((call) => call.x)).toEqual([0, 576]);
    expect(calls.map((call) => call.align)).toEqual(['left', 'right']);
  });
});
