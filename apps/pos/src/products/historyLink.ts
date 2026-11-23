import type { Role } from '@bikri/core';
import type { HistoryRef } from '../data/catalog.ts';
import { billVisible } from '../state/reportScope.ts';

export type HistoryLinkAccess = {
  role: Role;
  support: boolean;
  canViewReports: boolean;
  canViewCost: boolean;
  canCreatePurchase: boolean;
  /** The shop's business date (`useBusinessDates`). */
  today: string;
  branchId: string | null;
};

/**
 * Stock-history rows link only to screens this profile may actually open (13 §5):
 * a delivery reveals purchase unit costs, and a bill from another day or branch is a
 * dead-end "no access" screen for a cashier (screens/13, UI-H1).
 */
export function historyLinkVisible(
  ref: HistoryRef,
  access: HistoryLinkAccess,
): boolean {
  if (ref.kind === 'purchase')
    return access.canCreatePurchase || access.canViewCost;
  return billVisible(
    access.role,
    access.support,
    access.canViewReports,
    ref.businessDate === access.today,
    access.branchId === null || ref.branchId === access.branchId,
  );
}
