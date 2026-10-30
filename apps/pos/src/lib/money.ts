import { formatMoney, type NumberGrouping } from '@bikri/core';

/**
 * Shop-aware money formatting for call sites that cannot use the React context (event
 * handlers, canvas/PDF exports and toasts). The provider in `MoneyGrouping.tsx` keeps this
 * in step with `shop.number_grouping`; outside the app it stays at the default.
 */
let currentGrouping: NumberGrouping = 'intl';

export function setShopGrouping(grouping: NumberGrouping): void {
  currentGrouping = grouping;
}

export function shopGrouping(): NumberGrouping {
  return currentGrouping;
}

export function formatShopMoney(paisa: number): string {
  return formatMoney(paisa, currentGrouping);
}
