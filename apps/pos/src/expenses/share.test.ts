import { describe, expect, it } from 'vitest';
import { categorySharePercent } from './share.ts';

describe('categorySharePercent', () => {
  it('divides by the period total, not the largest category', () => {
    expect(categorySharePercent(500_000, 1_000_000)).toBe(50);
    expect(categorySharePercent(250_000, 1_000_000)).toBe(25);
  });

  it('returns 0 for a zero or negative total', () => {
    expect(categorySharePercent(0, 0)).toBe(0);
    expect(categorySharePercent(100, -1)).toBe(0);
  });

  it('clamps to 0–100 so a data glitch cannot render a wider bar', () => {
    expect(categorySharePercent(2_500_000, 1_000_000)).toBe(100);
    expect(categorySharePercent(-100, 1_000_000)).toBe(0);
  });
});
