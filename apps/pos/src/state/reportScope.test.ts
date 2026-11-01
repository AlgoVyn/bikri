import { describe, expect, it } from 'vitest';
import { cashierTodayOnly, seesAllDates } from './reportScope.ts';

describe('report scope (05 §6)', () => {
  it('limits a cashier to today and their branch', () => {
    expect(cashierTodayOnly('cashier', false)).toBe(true);
    expect(seesAllDates('cashier', false, true)).toBe(false);
  });

  it('gives owners, managers and the support view the full history', () => {
    for (const role of ['owner', 'manager'] as const) {
      expect(cashierTodayOnly(role, false)).toBe(false);
      expect(seesAllDates(role, false, true)).toBe(true);
    }
    expect(seesAllDates('cashier', true, true)).toBe(true);
  });

  it('honours a revoked report.view for every role', () => {
    expect(seesAllDates('manager', false, false)).toBe(false);
    expect(seesAllDates('owner', false, false)).toBe(false);
  });
});
