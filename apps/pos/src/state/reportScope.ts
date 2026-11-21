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

/**
 * 05 §6: `report.view` gates history *beyond today*. Today's own-branch bill stays
 * visible without it, and BillDetail/RefundDialog share this one rule so a bookmark
 * cannot show more than the list does.
 */
export function billVisible(
  role: Role,
  support: boolean,
  canViewReports: boolean,
  sameDay: boolean,
  sameBranch: boolean,
): boolean {
  if (seesAllDates(role, support, canViewReports)) return true;
  return sameDay && sameBranch;
}
