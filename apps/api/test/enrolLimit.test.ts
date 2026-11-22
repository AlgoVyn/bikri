import { describe, expect, it } from 'vitest';
import {
  enrolBlocked,
  enrolLimitSize,
  recordEnrolFailure,
  resetEnrolLimit,
} from '../src/auth/enrolLimit.ts';

describe('enrolLimit eviction', () => {
  it('evicts the oldest IPs instead of wiping the map', () => {
    resetEnrolLimit();
    const t0 = 1_000_000;
    for (let i = 0; i < 10_001; i += 1) {
      recordEnrolFailure(`10.0.${Math.floor(i / 256)}.${i % 256}`, t0 + i);
    }
    expect(enrolLimitSize()).toBe(9_000);
    // Newest IP is kept and still accumulates failures; the oldest is gone.
    const newest = `10.0.${Math.floor(10_000 / 256)}.${10_000 % 256}`;
    expect(enrolBlocked(newest, t0 + 10_000)).toBe(false);
    for (let i = 1; i <= 4; i += 1) recordEnrolFailure(newest, t0 + 10_000 + i);
    expect(enrolBlocked(newest, t0 + 10_005)).toBe(true);
    // The evicted IP starts over rather than inheriting the oldest bucket.
    expect(enrolBlocked('10.0.0.0', t0 + 10_005)).toBe(false);
    resetEnrolLimit();
  });
});
