import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBusinessDates } from './useBusinessDates.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useBusinessDates', () => {
  it('rolls over at midnight and follows a shop time-zone change', () => {
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
    const { result, rerender } = renderHook(
      ({ timeZone }: { timeZone: string }) => useBusinessDates(timeZone),
      { initialProps: { timeZone: 'UTC' } },
    );
    expect(result.current.today).toBe('2026-11-02');
    expect(result.current.yesterday).toBe('2026-11-01');

    // A tick on the same day keeps the state object (no re-render).
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.today).toBe('2026-11-02');

    vi.setSystemTime(new Date('2026-11-03T00:00:01Z'));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.today).toBe('2026-11-03');
    expect(result.current.yesterday).toBe('2026-11-02');

    // Month boundary.
    vi.setSystemTime(new Date('2026-12-01T00:00:01Z'));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.today).toBe('2026-12-01');
    expect(result.current.yesterday).toBe('2026-11-30');

    // Karachi is already on 2 Dec at 20:00 UTC on 1 Dec.
    vi.setSystemTime(new Date('2026-12-01T20:00:00Z'));
    act(() => {
      rerender({ timeZone: 'Asia/Karachi' });
    });
    expect(result.current.today).toBe('2026-12-02');
    expect(result.current.yesterday).toBe('2026-12-01');
  });
});
