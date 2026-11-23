import { describe, expect, it } from 'vitest';
import { formatQtyFromMilli, parseQtyToMilli } from './qty.ts';

describe('parseQtyToMilli', () => {
  it('stores whole units as milli', () => {
    expect(parseQtyToMilli('2', 'pc')).toBe(2000);
    expect(parseQtyToMilli('۰', 'dozen')).toBe(0);
    for (const unit of ['pc', 'pair', 'set', 'box', 'pack', 'dozen']) {
      expect(parseQtyToMilli('1.5', unit)).toBeNull();
    }
  });

  it('allows up to 3 decimals for measured units', () => {
    expect(parseQtyToMilli('1.5', 'm')).toBe(1500);
    expect(parseQtyToMilli('1.234', 'kg')).toBe(1234);
    expect(parseQtyToMilli('1.2', 'g')).toBe(1200);
    expect(parseQtyToMilli('0.5', 'l')).toBe(500);
    expect(parseQtyToMilli('۱٫۲۵', 'ml')).toBe(1250);
    expect(parseQtyToMilli('.5', 'kg')).toBe(500);
    expect(parseQtyToMilli('1.2345', 'm')).toBeNull();
  });

  it('rejects an unknown unit and empty input', () => {
    expect(parseQtyToMilli('1', 'tonne')).toBeNull();
    expect(parseQtyToMilli('', 'pc')).toBeNull();
    expect(parseQtyToMilli('-1', 'pc')).toBeNull();
  });

  it('strips non-breaking and thin spaces inside a quantity', () => {
    expect(parseQtyToMilli('1\u00A05', 'pc')).toBe(15_000);
    expect(parseQtyToMilli('1\u2009.5', 'm')).toBe(1_500);
    expect(parseQtyToMilli('1\u00A0000', 'pc')).toBe(1_000_000);
  });
});

describe('formatQtyFromMilli', () => {
  it('trims trailing zeros', () => {
    expect(formatQtyFromMilli(2000, 'pc')).toBe('2');
    expect(formatQtyFromMilli(1500, 'm')).toBe('1.5');
    expect(formatQtyFromMilli(1234, 'm')).toBe('1.234');
    expect(formatQtyFromMilli(1000, 'kg')).toBe('1');
    expect(formatQtyFromMilli(-1000, 'pc')).toBe('-1');
    expect(formatQtyFromMilli(-500, 'm')).toBe('-0.5');
    // Display must never throw for a mixed-unit aggregate or an edited unit.
    expect(formatQtyFromMilli(1500, 'pc')).toBe('1.5');
    expect(formatQtyFromMilli(1, 'box')).toBe('0.001');
    expect(() => formatQtyFromMilli(Number.MAX_SAFE_INTEGER + 1, 'm')).toThrow(
      /safe integer/,
    );
  });
});
