import { assertSafeInteger, mulDivRound, subSafe, sumSafe } from './money.ts';

export interface SupplierReturnLineInput {
  qty_milli: number;
  avg_cost: number;
  last_cost: number;
  /** Landed cost of the linked delivery line. Null when the return is not linked. */
  linked_landed_unit_cost: number | null;
  /** Manual override. When omitted, the default credit rule applies. */
  unit_credit?: number;
}

export interface SupplierReturnInput {
  supplier_balance_before: number;
  lines: readonly SupplierReturnLineInput[];
  refund_received: number;
}

export interface SupplierReturnLineResult {
  unit_credit: number;
  line_total: number;
  cost_snapshot: number;
  stock_delta_milli: number;
}

export interface SupplierReturnResult {
  lines: SupplierReturnLineResult[];
  total: number;
  return_difference: number;
  suggested_refund: number;
  /** Supplier ledger amounts: −total, then +refund_received when money comes back. */
  ledger: number[];
  supplier_balance_after: number;
  avg_cost_after: 'unchanged';
}

function defaultUnitCredit(line: SupplierReturnLineInput): number {
  if (line.unit_credit !== undefined) {
    return line.unit_credit;
  }
  if (line.linked_landed_unit_cost !== null) {
    return line.linked_landed_unit_cost;
  }
  if (line.avg_cost !== 0) {
    return line.avg_cost;
  }
  return line.last_cost;
}

function priceLine(line: SupplierReturnLineInput): SupplierReturnLineResult {
  assertSafeInteger(line.qty_milli, 'qty_milli');
  assertSafeInteger(line.avg_cost, 'avg_cost');
  assertSafeInteger(line.last_cost, 'last_cost');
  if (line.linked_landed_unit_cost !== null) {
    assertSafeInteger(line.linked_landed_unit_cost, 'linked_landed_unit_cost');
  }
  if (line.qty_milli <= 0) {
    throw new RangeError('qty_milli must be positive');
  }
  if (line.avg_cost < 0 || line.last_cost < 0) {
    throw new RangeError('cost must be non-negative');
  }
  if (
    line.linked_landed_unit_cost !== null &&
    line.linked_landed_unit_cost < 0
  ) {
    throw new RangeError('landed cost must be non-negative');
  }
  const unitCredit = defaultUnitCredit(line);
  assertSafeInteger(unitCredit, 'unit_credit');
  if (unitCredit < 0) {
    throw new RangeError('unit credit must be non-negative');
  }
  return {
    unit_credit: unitCredit,
    line_total: mulDivRound(line.qty_milli, unitCredit, 1000),
    cost_snapshot: line.avg_cost,
    stock_delta_milli: -line.qty_milli,
  };
}

/** Credit, stock and ledger effect of a return to supplier (07 §10, D-047). */
export function computeSupplierReturn(
  input: SupplierReturnInput,
): SupplierReturnResult {
  assertSafeInteger(input.supplier_balance_before, 'supplier_balance_before');
  assertSafeInteger(input.refund_received, 'refund_received');
  if (input.lines.length === 0) {
    throw new RangeError('a supplier return needs at least one line');
  }
  if (input.refund_received < 0) {
    throw new RangeError('refund_received must be non-negative');
  }
  const lines = input.lines.map((line) => priceLine(line));
  const total = sumSafe(lines.map((line) => line.line_total));
  if (total <= 0) {
    throw new RangeError('return total must be positive');
  }
  if (input.refund_received > total) {
    throw new RangeError('refund_received cannot exceed the return total');
  }
  const stockCost = sumSafe(
    input.lines.map((line) => mulDivRound(line.qty_milli, line.avg_cost, 1000)),
  );
  const owed = Math.max(input.supplier_balance_before, 0);
  const uncovered = total - owed;
  const suggested = Math.max(uncovered, 0);
  const ledger = [-total];
  if (input.refund_received > 0) {
    ledger.push(input.refund_received);
  }
  const afterCredit = subSafe(input.supplier_balance_before, total);
  return {
    lines,
    total,
    return_difference: subSafe(total, stockCost),
    suggested_refund: suggested,
    ledger,
    supplier_balance_after: sumSafe([afterCredit, input.refund_received]),
    avg_cost_after: 'unchanged',
  };
}
