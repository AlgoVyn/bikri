import { describe, expect, it } from 'vitest';
import { formatBusinessDate, formatTimestamp } from './date.ts';

const at = Date.UTC(2026, 9, 30, 4, 44);

describe('date formatting', () => {
  it('uses one short date-time format with uppercase AM/PM', () => {
    expect(formatTimestamp(at, 'en')).toBe('30 Oct 2026, 9:44 AM');
  });

  it('uses Urdu month names with Western digits', () => {
    const text = formatTimestamp(at, 'ur');
    expect(text).toContain('اکتوبر');
    expect(text).toContain('2026');
    expect(text).toMatch(/\d/u);
  });

  it('formats a business date without a UTC day shift', () => {
    expect(formatBusinessDate('2026-10-30', 'en')).toBe('30 Oct 2026');
    expect(formatBusinessDate('2026-10-30', 'en', 'Asia/Karachi', 'long')).toBe(
      '30 October 2026',
    );
  });

  it('returns the input for an invalid business date', () => {
    expect(formatBusinessDate('not-a-date', 'en')).toBe('not-a-date');
  });
});
