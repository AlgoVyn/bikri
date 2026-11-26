import { describe, expect, it } from 'vitest';
import { cellBoxes } from './cellLayout.ts';

describe('canvas cell layout (PRT-M1)', () => {
  it('keeps one LTR name/qty/amount order for a mixed English/Urdu row', () => {
    const boxes = cellBoxes(
      [
        { text: 'کیبل 1m' },
        { text: '2', align: 'end' },
        { text: 'Rs 900', align: 'end' },
      ],
      576,
      48,
    );
    expect(boxes).toEqual([
      { text: 'کیبل 1m', x: 0, align: 'left', maxWidth: 336, rtl: true },
      { text: '2', x: 396, align: 'right', maxWidth: 60, rtl: false },
      { text: 'Rs 900', x: 576, align: 'right', maxWidth: 180, rtl: false },
    ]);
    // The columns never reverse: Urdu is a per-cell direction, not a row flip.
    expect(boxes.map((box) => box.x)).toEqual([0, 396, 576]);
  });

  it('keeps the same order when every header cell is Urdu', () => {
    const boxes = cellBoxes(
      [
        { text: 'چیز' },
        { text: 'تعداد', align: 'end' },
        { text: 'رقم', align: 'end' },
      ],
      576,
      48,
    );
    expect(boxes.map((box) => box.text)).toEqual(['چیز', 'تعداد', 'رقم']);
    expect(boxes.map((box) => box.rtl)).toEqual([true, true, true]);
    expect(boxes.map((box) => box.x)).toEqual([0, 396, 576]);
    expect(boxes.map((box) => box.maxWidth)).toEqual([336, 60, 180]);
  });

  it('bounds a two-cell pair row to the printable width', () => {
    expect(
      cellBoxes(
        [{ text: 'کل بیلنس' }, { text: 'Rs 1,250', align: 'end' }],
        384,
        32,
      ),
    ).toEqual([
      { text: 'کل بیلنس', x: 0, align: 'left', maxWidth: 230, rtl: true },
      {
        text: 'Rs 1,250',
        x: 384,
        align: 'right',
        maxWidth: 154,
        rtl: false,
      },
    ]);
  });
});
