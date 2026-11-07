import { describe, expect, it } from 'vitest';
import { isBusinessDate } from './dates.ts';

describe('isBusinessDate', () => {
  it('accepts real calendar dates only', () => {
    expect(isBusinessDate('2026-11-07')).toBe(true);
    expect(isBusinessDate('2024-02-29')).toBe(true);
    expect(isBusinessDate('2026-02-29')).toBe(false);
    expect(isBusinessDate('2026-02-31')).toBe(false);
    expect(isBusinessDate('2026-13-01')).toBe(false);
    expect(isBusinessDate('07-11-2026')).toBe(false);
  });
});
