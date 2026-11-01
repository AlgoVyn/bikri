import type { Role } from '@bikri/core';

/**
 * 05 §6: `report.view` is "today only" for a cashier. A support profile is a
 * read-only operator view and keeps the full range.
 */
export function cashierTodayOnly(role: Role, support: boolean): boolean {
  return role === 'cashier' && !support;
}

/** Whether this profile may see bills from before today. */
export function seesAllDates(
  role: Role,
  support: boolean,
  canViewReports: boolean,
): boolean {
  return canViewReports && !cashierTodayOnly(role, support);
}
