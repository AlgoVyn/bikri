import { describe, expect, it } from 'vitest';
import { clampReportRange, LONG_RANGE_DAYS, spanDays } from './reportRange.ts';

describe('report range', () => {
  it('counts inclusive days and rejects invalid dates', () => {
    expect(spanDays('2026-01-01', '2026-01-01')).toBe(1);
    expect(spanDays('2026-01-01', '2026-01-03')).toBe(3);
    expect(spanDays('2026-01-03', '2026-01-01')).toBe(0);
    expect(spanDays('2026-02-31', '2026-03-01')).toBe(0);
    expect(spanDays('', '2026-01-01')).toBe(0);
  });

  it('clamps a mistyped year to the shop history and today', () => {
    const result = clampReportRange(
      { from: '0202-01-01', to: '9999-12-31' },
      '2026-10-01',
      '2026-11-17',
    );
    expect(result.range).toEqual({ from: '2026-10-01', to: '2026-11-17' });
    expect(result.clamped).toBe(true);
    expect(result.days).toBe(48);
    expect(result.long).toBe(true);
    expect(result.requestedDays).toBeGreaterThan(LONG_RANGE_DAYS);
  });

  it('keeps a range entirely before the shop history small and empty', () => {
    const result = clampReportRange(
      { from: '0202-01-01', to: '0203-01-01' },
      '2026-10-01',
      '2026-11-17',
    );
    expect(result.range).toEqual({ from: '0203-01-01', to: '0203-01-01' });
    expect(result.days).toBe(1);
  });

  it('clamps the end to today and leaves a valid range alone', () => {
    const valid = clampReportRange(
      { from: '2026-11-01', to: '2026-11-10' },
      '2026-10-01',
      '2026-11-17',
    );
    expect(valid.range).toEqual({ from: '2026-11-01', to: '2026-11-10' });
    expect(valid.clamped).toBe(false);
    expect(valid.long).toBe(false);
    expect(
      clampReportRange(
        { from: '2026-11-01', to: '2027-01-01' },
        '2026-10-01',
        '2026-11-17',
      ).range.to,
    ).toBe('2026-11-17');
  });

  it('falls back to today for invalid dates and keeps an inverted range small', () => {
    expect(
      clampReportRange(
        { from: '2026-12-01', to: '2026-11-01' },
        null,
        '2026-11-17',
      ).range,
    ).toEqual({ from: '2026-11-01', to: '2026-11-01' });
    expect(
      clampReportRange(
        { from: 'not-a-date', to: 'also-not-a-date' },
        null,
        '2026-11-17',
      ).range,
    ).toEqual({ from: '2026-11-17', to: '2026-11-17' });
  });
});
