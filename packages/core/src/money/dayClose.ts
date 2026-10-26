import { subSafe, sumSafe } from './money.ts';

export interface DayCloseInput {
  opening_cash: number;
  cash_sales: number;
  udhaar_cash_in: number;
  pay_ins: number;
  supplier_cash_in: number;
  cash_refunds: number;
  cash_expenses: number;
  supplier_cash_out: number;
  pay_outs: number;
  counted_cash: number;
}

export type DrawerStatus = 'correct' | 'short' | 'over';

export interface DayCloseResult extends DayCloseInput {
  expected_cash: number;
  difference: number;
  drawer: DrawerStatus;
}

/** Drawer expected cash for one device (07 §8, D-007, D-047). */
export function computeDayClose(input: DayCloseInput): DayCloseResult {
  const inflow = sumSafe([
    input.opening_cash,
    input.cash_sales,
    input.udhaar_cash_in,
    input.pay_ins,
    input.supplier_cash_in,
  ]);
  const outflow = sumSafe([
    input.cash_refunds,
    input.cash_expenses,
    input.supplier_cash_out,
    input.pay_outs,
  ]);
  const expectedCash = subSafe(inflow, outflow);
  const difference = subSafe(input.counted_cash, expectedCash);
  const drawer: DrawerStatus =
    difference === 0 ? 'correct' : difference < 0 ? 'short' : 'over';
  return {
    opening_cash: input.opening_cash,
    cash_sales: input.cash_sales,
    udhaar_cash_in: input.udhaar_cash_in,
    pay_ins: input.pay_ins,
    supplier_cash_in: input.supplier_cash_in,
    cash_refunds: input.cash_refunds,
    cash_expenses: input.cash_expenses,
    supplier_cash_out: input.supplier_cash_out,
    pay_outs: input.pay_outs,
    counted_cash: input.counted_cash,
    expected_cash: expectedCash,
    difference,
    drawer,
  };
}
