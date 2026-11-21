import { describe, expect, it } from 'vitest';
import { addDays, daysBetween } from './format.ts';

describe('daysBetween', () => {
  it('is inclusive, so Today is one day and a week is seven', () => {
    expect(daysBetween('2026-11-22', '2026-11-22')).toBe(1);
    expect(daysBetween('2026-11-16', '2026-11-22')).toBe(7);
    expect(daysBetween('2026-10-24', '2026-11-22')).toBe(30);
    expect(daysBetween('2026-08-25', '2026-11-22')).toBe(90);
  });

  it('gives the same-length previous window when used without another +1', () => {
    const from = '2026-11-22';
    const to = '2026-11-22';
    const span = daysBetween(from, to);
    expect(addDays(from, -span)).toBe('2026-11-21');
    expect(addDays(from, -1)).toBe('2026-11-21');
    expect(daysBetween(addDays(from, -span), addDays(from, -1))).toBe(span);
  });
});
