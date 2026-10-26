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
    expect(parseQtyToMilli('1.2345', 'm')).toBeNull();
  });

  it('rejects an unknown unit and empty input', () => {
    expect(parseQtyToMilli('1', 'tonne')).toBeNull();
    expect(parseQtyToMilli('', 'pc')).toBeNull();
    expect(parseQtyToMilli('-1', 'pc')).toBeNull();
  });
});

describe('formatQtyFromMilli', () => {
  it('trims trailing zeros', () => {
    expect(formatQtyFromMilli(2000, 'pc')).toBe('2');
    expect(formatQtyFromMilli(1500, 'm')).toBe('1.5');
    expect(formatQtyFromMilli(1234, 'm')).toBe('1.234');
    expect(formatQtyFromMilli(1000, 'kg')).toBe('1');
  });
});
