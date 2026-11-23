import { type QtyUnit, qtyAllowsDecimals } from '@bikri/core';

/** The smallest recipe quantity a component may have: 0.001 for kg/litre, 1 whole piece otherwise. */
export function minBundleQty(unit: QtyUnit): number {
  return qtyAllowsDecimals(unit) ? 1 : 1000;
}

/** Whether a typed recipe quantity is usable for the component's unit. */
export function bundleQtyValid(qtyMilli: number, unit: QtyUnit): boolean {
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli < 1) return false;
  return qtyAllowsDecimals(unit) ? true : qtyMilli % 1000 === 0;
}

/**
 * Repair a recipe line on blur/submit: an empty/zero line becomes the minimum, and an
 * integer unit keeps whole pieces (500 pc → 1 pc). While the owner is typing the raw
 * value is kept, so `0.5` can be entered for a fractional component (UI-H4).
 */
export function clampBundleQty(qtyMilli: number | null, unit: QtyUnit): number {
  const min = minBundleQty(unit);
  if (qtyMilli === null || !Number.isSafeInteger(qtyMilli) || qtyMilli <= 0)
    return min;
  if (qtyAllowsDecimals(unit)) return Math.max(min, qtyMilli);
  return Math.max(min, Math.floor(qtyMilli / 1000) * 1000);
}
