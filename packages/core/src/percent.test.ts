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
});
