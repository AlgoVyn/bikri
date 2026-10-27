import { assertSafeInteger, mulDivRound, sumSafe } from './money.ts';

const COSTED_REASONS: ReadonlySet<string> = new Set([
  'opening',
  'purchase',
  'received_godown',
  'received_local',
  'received_other',
]);

/** On hand is the sum of movement deltas (07 §5, §7). */
export function onHandMilli(deltas: readonly number[]): number {
  return sumSafe(deltas);
}

export interface StockValueInput {
  on_hand_milli: number;
  avg_cost: number;
  track_stock: 0 | 1 | boolean;
}

/** Stock value of tracked products, ignoring negative on-hand (07 §9). */
export function stockValuePaisa(products: readonly StockValueInput[]): number {
  const values: number[] = [];
  for (const product of products) {
    assertSafeInteger(product.on_hand_milli, 'on_hand_milli');
    assertSafeInteger(product.avg_cost, 'avg_cost');
    if (product.avg_cost < 0) {
      throw new RangeError('avg_cost must be non-negative');
    }
    const tracked = product.track_stock === true || product.track_stock === 1;
    if (!tracked) {
      continue;
    }
    const held = Math.max(product.on_hand_milli, 0);
    values.push(mulDivRound(held, product.avg_cost, 1000));
  }
  return sumSafe(values);
}

/** True for receipt reasons that carry a unit cost and move the average (07 §7). */
export function movementChangesAvgCost(reasonCode: string): boolean {
  return COSTED_REASONS.has(reasonCode);
}
