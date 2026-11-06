import { describe, expect, it } from 'vitest';
import { lineRevenue } from './reports.ts';

describe('lineRevenue (07 §9)', () => {
  it('subtracts the bill-discount share, and tax only when the price includes it', () => {
    expect(lineRevenue(10_000, 500, 1_700, false)).toBe(9_500);
    expect(lineRevenue(10_000, 500, 1_700, true)).toBe(7_800);
  });

  it('keeps a negative adjustment negative', () => {
    expect(lineRevenue(100, 250, 0, false)).toBe(-150);
  });
});
