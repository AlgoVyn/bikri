import { describe, expect, it } from 'vitest';
import {
  DATE_FORMATTER_LIMIT,
  dateFormatterCacheSize,
  formatReceiptDate,
} from './format.ts';

describe('formatReceiptDate cache (L9)', () => {
  it('caps cached time zones and still formats after eviction', () => {
    const zones = Intl.supportedValuesOf('timeZone');
    const at = Date.parse('2026-10-27T19:30:00Z');
    for (let i = 0; i < DATE_FORMATTER_LIMIT + 20; i += 1) {
      // The list is long enough on every ICU build; wrap defensively.
      formatReceiptDate(at, zones[i % zones.length] ?? 'UTC');
    }
    expect(dateFormatterCacheSize()).toBeLessThanOrEqual(DATE_FORMATTER_LIMIT);
    // An evicted zone is recreated on demand with the same output.
    expect(formatReceiptDate(at, 'Asia/Karachi')).toBe('28-10-2026 00:30');
  });

  it('keeps the shop default and falls back to a 24-hour clock', () => {
    expect(formatReceiptDate(Date.parse('2026-10-27T19:30:00Z'))).toBe(
      '28-10-2026 00:30',
    );
    expect(formatReceiptDate(Date.parse('2026-10-27T00:00:00Z'))).toBe(
      '27-10-2026 05:00',
    );
  });
});
