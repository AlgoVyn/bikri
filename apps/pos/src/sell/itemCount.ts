import { qtyAllowsDecimals } from '@bikri/core';
import type { CartLine } from '@bikri/db';

/**
 * `Subtotal (n items)` counts pieces for unit lines and one per weighed line
 * (screens/05). A bundle is several component lines; its pieces are the component
 * quantities, which is what the cart summary has always shown.
 */
export function cartItemCount(lines: readonly CartLine[]): number {
  let count = 0;
  for (const line of lines)
    count += qtyAllowsDecimals(line.unit ?? 'pc')
      ? 1
      : Math.round(Number(line.qty_milli) / 1000);
  return count;
}
