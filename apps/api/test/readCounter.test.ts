import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRowsRead,
  pendingRowsRead,
  takeRowsRead,
} from '../src/platform/readCounter.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('read counter', () => {
  it('flushes and resets at UTC midnight', () => {
    vi.setSystemTime(new Date('2026-11-05T23:59:00Z'));
    addRowsRead('tenant-a', 100);
    expect(pendingRowsRead('tenant-a')).toBe(100);

    vi.setSystemTime(new Date('2026-11-06T00:00:01Z'));
    expect(pendingRowsRead('tenant-a')).toBe(0);
    addRowsRead('tenant-a', 5);
    expect(takeRowsRead('tenant-a')).toBe(5);
    expect(pendingRowsRead('tenant-a')).toBe(0);
  });

  it('does not return yesterday rows from take', () => {
    vi.setSystemTime(new Date('2026-11-05T23:59:00Z'));
    addRowsRead('tenant-b', 100);
    vi.setSystemTime(new Date('2026-11-06T00:00:01Z'));
    expect(takeRowsRead('tenant-b')).toBe(0);
  });
});
