import { assertSafeInteger, roundHalfAway } from './money.ts';

export interface AvgCostInput {
  on_hand_milli: number;
  avg_cost: number;
  qty_milli: number;
  unit_cost: number;
}

/**
 * Next weighted-average cost after one costed receipt (07 §7, D-038).
 * One half-away division of the BigInt sum, so the products may exceed 2^53.
 * On-hand at or below zero resets the average to the new unit cost.
 */
export function nextAvgCost(input: AvgCostInput): number {
  assertSafeInteger(input.on_hand_milli, 'on_hand_milli');
  assertSafeInteger(input.avg_cost, 'avg_cost');
  assertSafeInteger(input.qty_milli, 'qty_milli');
  assertSafeInteger(input.unit_cost, 'unit_cost');
  if (input.qty_milli <= 0) {
    throw new RangeError('qty_milli must be positive');
  }
  if (input.avg_cost < 0 || input.unit_cost < 0) {
    throw new RangeError('cost must be non-negative');
  }
  if (input.on_hand_milli <= 0) {
    return input.unit_cost;
  }
  const onHand = BigInt(input.on_hand_milli);
  const qty = BigInt(input.qty_milli);
  const numerator =
    onHand * BigInt(input.avg_cost) + qty * BigInt(input.unit_cost);
  return roundHalfAway(numerator, onHand + qty);
}
