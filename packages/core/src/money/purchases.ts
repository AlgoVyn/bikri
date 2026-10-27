import { allocate, assertSafeInteger, mulDivRound, sumSafe } from './money.ts';

export interface PurchaseLineInput {
  qty_milli: number;
  unit_cost: number;
}

export interface PurchaseLineResult {
  qty_milli: number;
  unit_cost: number;
  line_total: number;
  charges_alloc: number;
  landed_unit_cost: number;
}

export interface PurchaseResult {
  lines: PurchaseLineResult[];
  other_charges: number;
  goods_total: number;
  total: number;
}

/**
 * Line totals, freight allocation and landed unit cost (02 purchase_lines, D-034).
 * `other_charges` are allocated by `line_total`. When every line total is 0,
 * allocate's W = 0 rule leaves the charges unallocated; they still sit on `total`.
 */
export function computePurchase(
  lines: readonly PurchaseLineInput[],
  otherCharges: number,
): PurchaseResult {
  assertSafeInteger(otherCharges, 'other_charges');
  if (otherCharges < 0) {
    throw new RangeError('other_charges must be non-negative');
  }
  const priced = lines.map((line) => {
    assertSafeInteger(line.qty_milli, 'qty_milli');
    assertSafeInteger(line.unit_cost, 'unit_cost');
    if (line.qty_milli <= 0) {
      throw new RangeError('qty_milli must be positive');
    }
    if (line.unit_cost < 0) {
      throw new RangeError('unit_cost must be non-negative');
    }
    return {
      qty_milli: line.qty_milli,
      unit_cost: line.unit_cost,
      line_total: mulDivRound(line.qty_milli, line.unit_cost, 1000),
    };
  });
  const charges = allocate(
    otherCharges,
    priced.map((line) => line.line_total),
  );
  const resultLines: PurchaseLineResult[] = priced.map((line, index) => {
    const chargesAlloc = charges[index] as number;
    return {
      qty_milli: line.qty_milli,
      unit_cost: line.unit_cost,
      line_total: line.line_total,
      charges_alloc: chargesAlloc,
      landed_unit_cost: mulDivRound(
        line.line_total + chargesAlloc,
        1000,
        line.qty_milli,
      ),
    };
  });
  const goodsTotal = sumSafe(resultLines.map((line) => line.line_total));
  return {
    lines: resultLines,
    other_charges: otherCharges,
    goods_total: goodsTotal,
    total: sumSafe([goodsTotal, otherCharges]),
  };
}
