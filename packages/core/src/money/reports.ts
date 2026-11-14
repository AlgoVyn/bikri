/** Report formulas (07 §9). Kept in core so every screen and export uses one definition. */
import { assertSafeInteger } from './money.ts';

/** Line revenue ex-tax and ex-rounding: net − bill-discount share (− tax when tax-inclusive). */
export function lineRevenue(
  net: number,
  billDiscountAlloc: number,
  taxAlloc: number,
  taxInclusive: boolean,
): number {
  assertSafeInteger(net, 'net');
  assertSafeInteger(billDiscountAlloc, 'billDiscountAlloc');
  assertSafeInteger(taxAlloc, 'taxAlloc');
  return net - billDiscountAlloc - (taxInclusive ? taxAlloc : 0);
}
