import { describe, expect, it } from 'vitest';
import { denominationCount } from './DayClosePage.tsx';

describe('day-close denomination inputs', () => {
  it('keeps counts whole and accepts Urdu/Arabic-Indic digits', () => {
    expect(denominationCount('12')).toBe(12);
    expect(denominationCount('0.333')).toBe(333);
    expect(denominationCount('۱٤')).toBe(14);
    expect(denominationCount('')).toBe(0);
    expect(denominationCount('999999999')).toBe(1_000_000);
  });
});
