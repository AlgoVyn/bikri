import { describe, expect, it } from 'vitest';
import { businessDate, DEFAULT_TIME_ZONE, isTimeZone } from './dates.ts';
import { generateSku } from './sku.ts';

describe('businessDate', () => {
  it('uses the shop time zone (Asia/Karachi = UTC+5)', () => {
    expect(businessDate(Date.UTC(2026, 9, 27, 18, 59))).toBe('2026-10-27');
    expect(businessDate(Date.UTC(2026, 9, 27, 19, 0))).toBe('2026-10-28');
    expect(businessDate(Date.UTC(2026, 9, 27, 19, 0), 'UTC')).toBe(
      '2026-10-27',
    );
  });

  it('falls back to the documented zone for a typo instead of throwing', () => {
    expect(businessDate(Date.UTC(2026, 9, 27, 19, 0), 'Asia/Karach')).toBe(
      '2026-10-28',
    );
    expect(businessDate(Date.UTC(2026, 9, 27, 19, 0), '')).toBe('2026-10-28');
  });

  it('recognises IANA zones and rejects junk', () => {
    expect(isTimeZone(DEFAULT_TIME_ZONE)).toBe(true);
    expect(isTimeZone('Asia/Dubai')).toBe(true);
    expect(isTimeZone('Asia/Karach')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone('x'.repeat(65))).toBe(false);
    expect(isTimeZone(42)).toBe(false);
  });
});

describe('generateSku', () => {
  it('takes 3 letters of the name and 4 base32 chars', () => {
    expect(generateSku('Samsung A15', () => 0)).toBe('SAM-0000');
    expect(generateSku('9v', () => 0.99)).toBe('VXX-ZZZZ');
    expect(generateSku('USB-C cable')).toMatch(/^USB-[0-9A-HJKMNP-TV-Z]{4}$/);
  });
});
