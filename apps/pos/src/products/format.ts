import { formatQtyFromMilli } from '@bikri/core';
import type { TFunction } from 'i18next';

/** True when a name has no Arabic-script characters, so it can use the Latin face. */
export function isLatinName(name: string): boolean {
  return !/[\u0600-\u06ff]/u.test(name);
}

/** "12 pc" with the unit in the UI language. */
export function qtyWithUnit(t: TFunction, milli: number, unit: string): string {
  return `${formatQtyFromMilli(milli, unit)} ${t(`unit.${unit}`)}`;
}

/** (price − avg) / price as "25.3%"; null when price is 0 or cost unknown. */
export function marginText(price: number, avgCost: number): string | null {
  if (price <= 0 || avgCost <= 0) return null;
  return `${(((price - avgCost) / price) * 100).toFixed(1)}%`;
}
