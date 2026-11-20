import { describe, expect, it } from 'vitest';
import { effectiveAutoLockMinutes, shouldAutoLock } from './autoLock.ts';

describe('auto-lock idle decision (SYNC-M1)', () => {
  it('locks after the configured wall-clock minutes', () => {
    expect(shouldAutoLock(10, 'cashier', 9 * 60_000)).toBe(false);
    expect(shouldAutoLock(10, 'cashier', 10 * 60_000)).toBe(true);
  });

  it('treats owner 0 as never but gives staff the safe 10-minute fallback', () => {
    expect(effectiveAutoLockMinutes(0, 'owner')).toBe(0);
    expect(effectiveAutoLockMinutes(0, 'cashier')).toBe(10);
    expect(shouldAutoLock(0, 'owner', 24 * 60 * 60_000)).toBe(false);
    expect(shouldAutoLock(0, 'cashier', 10 * 60_000)).toBe(true);
  });
});
