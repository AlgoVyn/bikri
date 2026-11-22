import { describe, expect, it } from 'vitest';
import { parsePercentToBp } from './percent.ts';

describe('parsePercentToBp', () => {
  it('parses decimals, signs and localized digits without floats', () => {
    expect(parsePercentToBp('10')).toBe(1000);
    expect(parsePercentToBp('2.5')).toBe(250);
    expect(parsePercentToBp('12.345%')).toBe(1235);
    expect(parsePercentToBp('-5')).toBe(-500);
    expect(parsePercentToBp('−7.5')).toBe(-750);
    expect(parsePercentToBp('۱۰')).toBe(1000);
    expect(parsePercentToBp('۴۳٫۵')).toBe(4350);
    expect(parsePercentToBp(' . ')).toBeNull();
    expect(parsePercentToBp('1.2.3')).toBeNull();
    expect(parsePercentToBp('')).toBeNull();
  });

  it('rejects unsafe, mid-string and over-precise values', () => {
    expect(parsePercentToBp('90071992547410')).toBeNull();
    expect(parsePercentToBp('1%5')).toBeNull();
    expect(parsePercentToBp('%10')).toBeNull();
    expect(parsePercentToBp('1.2345')).toBeNull();
    expect(Object.is(parsePercentToBp('-0'), -0)).toBe(false);
  });
});
