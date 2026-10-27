import { describe, expect, it } from 'vitest';
import {
  a4Slots,
  barcodeLabelSvg,
  LABEL_SIZES,
  LabelError,
  moduleMm,
} from './layout.ts';

describe('label layout (screens/20)', () => {
  it('chooses whole printer dots and falls back before failing', () => {
    expect(moduleMm(LABEL_SIZES['50x25'], 121, 203)).toBeCloseTo(0.375);
    expect(moduleMm(LABEL_SIZES['38x25'], 143, 203)).toBeCloseTo(0.25);
    expect(moduleMm(LABEL_SIZES['50x25'], 121, 300)).toBeCloseTo(0.3387, 3);
    expect(() => moduleMm(LABEL_SIZES['38x25'], 220, 203)).toThrow(LabelError);
  });

  it('renders a 12-digit generated code and rejects non-ASCII', () => {
    const label = barcodeLabelSvg('200000000017', LABEL_SIZES['50x25'], 203);
    expect(label.code.modules).toBe(121);
    expect(label.svg).toContain('viewBox="0 0 50 10"');
    expect(label.svg).toContain('<rect');
    expect(() => barcodeLabelSvg('اردو', LABEL_SIZES['50x25'])).toThrow(
      LabelError,
    );
  });

  it('A4 start position 5 leaves cells 6–9', () => {
    expect(a4Slots(5).slice(0, 4)).toEqual([
      { column: 2, row: 1 },
      { column: 0, row: 2 },
      { column: 1, row: 2 },
      { column: 2, row: 2 },
    ]);
  });
});
