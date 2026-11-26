import { businessDate, type Role } from '@bikri/core';

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

/**
 * screens/21: a cashier without `report.view` may see open quotes of any date (to
 * convert one) and converted/cancelled quotes from today only. Viewing any quote also
 * requires `sale.create`. Owners/managers with reports see every date, like bills.
 */
export function quoteVisible(input: {
  role: Role;
  support: boolean;
  canViewReports: boolean;
  canQuote: boolean;
  status: string;
  businessDate: string;
  branchId: string | null;
  quoteBranchId: string;
  today: string;
  timeZone: string;
  convertedAt?: number | null;
  cancelledAt?: number | null;
}): boolean {
  if (!input.canQuote) return false;
  if (seesAllDates(input.role, input.support, input.canViewReports))
    return true;
  if (
    input.branchId !== null &&
    input.quoteBranchId !== '' &&
    input.quoteBranchId !== input.branchId
  )
    return false;
  if (input.status === 'open') return true;
  const at =
    input.status === 'converted'
      ? Number(input.convertedAt ?? 0)
      : Number(input.cancelledAt ?? 0);
  return at > 0 && businessDate(at, input.timeZone) === input.today;
}
