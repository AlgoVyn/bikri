import { assertSafeInteger, mulDivRound, roundTo, subSafe } from './money.ts';

export type RefundRounding = 'nearest' | 'down' | 'none';
export type RefundMethod = 'cash' | 'card' | 'bank_wallet';

export interface CashRefund {
  amount: number;
  rounding: number;
}

export interface PriorRefund {
  amount: number;
  udhaar_part: number;
}

export interface SplitRefundInput {
  exact: number;
  paid_total: number;
  udhaar_amount: number;
  prior_refunds?: readonly PriorRefund[];
  /** Requested method of the paid part. Cash when omitted. Ignored when nothing is paid back. */
  method?: RefundMethod | null;
  refund_rounding?: RefundRounding;
}

export interface SplitRefundResult {
  exact: number;
  udhaar_part: number;
  paid_exact: number;
  method: RefundMethod | null;
  amount: number;
  rounding: number;
}

const RUPEE = 100;

function floorToRupee(paisa: number): number {
  return paisa - (paisa % RUPEE);
}

function readRounding(mode: RefundRounding | undefined): RefundRounding {
  if (mode === undefined || mode === 'nearest') {
    return 'nearest';
  }
  if (mode === 'down' || mode === 'none') {
    return mode;
  }
  throw new RangeError('refund_rounding must be nearest, down or none');
}

function amountForMode(paidExact: number, mode: RefundRounding): number {
  if (mode === 'nearest') {
    return roundTo(paidExact, RUPEE);
  }
  if (mode === 'down') {
    return floorToRupee(paidExact);
  }
  return paidExact;
}

/**
 * Cash rounding of the paid part (07 §6).
 * When `remainingPaid` is set and the rounded amount exceeds it, floor to the
 * rupee; if that still exceeds the remainder, keep the remainder.
 */
export function roundCashRefund(
  paidExact: number,
  mode: RefundRounding = 'nearest',
  remainingPaid?: number,
): CashRefund {
  assertSafeInteger(paidExact, 'paidExact');
  if (paidExact < 0) {
    throw new RangeError('paidExact must be non-negative');
  }
  const rounding = readRounding(mode);
  let cap: number | undefined;
  if (remainingPaid !== undefined) {
    assertSafeInteger(remainingPaid, 'remainingPaid');
    cap = Math.max(remainingPaid, 0);
  }
  let amount = amountForMode(paidExact, rounding);
  if (cap !== undefined && amount > cap) {
    const floored = floorToRupee(paidExact);
    amount = floored > cap ? cap : floored;
  }
  return { amount, rounding: amount - paidExact };
}

function cumulativeShare(
  total: number,
  soldMilli: number,
  prevMilli: number,
  qtyMilli: number,
): number {
  assertSafeInteger(total, 'total');
  assertSafeInteger(soldMilli, 'soldMilli');
  assertSafeInteger(prevMilli, 'prevMilli');
  assertSafeInteger(qtyMilli, 'qtyMilli');
  if (soldMilli <= 0) {
    throw new RangeError('sold quantity must be positive');
  }
  if (prevMilli < 0 || qtyMilli < 0) {
    throw new RangeError('refund quantities must be non-negative');
  }
  const next = prevMilli + qtyMilli;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError('refunded quantity exceeds safe integer');
  }
  return subSafe(
    mulDivRound(total, next, soldMilli),
    mulDivRound(total, prevMilli, soldMilli),
  );
}

/** Paisa refunded for `refundMilli` more units of a line (07 §6). */
export function computeRefundLine(
  lineFinal: number,
  soldMilli: number,
  prevRefundedMilli: number,
  refundMilli: number,
): number {
  return cumulativeShare(lineFinal, soldMilli, prevRefundedMilli, refundMilli);
}

/** Revenue removed by a refund, same cumulative pattern as the line amount. */
export function refundedRevenue(
  lineRevenue: number,
  soldMilli: number,
  prevRefundedMilli: number,
  refundMilli: number,
): number {
  return cumulativeShare(
    lineRevenue,
    soldMilli,
    prevRefundedMilli,
    refundMilli,
  );
}

/** Cost removed by a refund: cumulative qty × unit cost snapshot. */
export function refundedCost(
  unitCostSnapshot: number,
  prevRefundedMilli: number,
  refundMilli: number,
): number {
  assertSafeInteger(unitCostSnapshot, 'unitCostSnapshot');
  assertSafeInteger(prevRefundedMilli, 'prevRefundedMilli');
  assertSafeInteger(refundMilli, 'refundMilli');
  if (unitCostSnapshot < 0) {
    throw new RangeError('unit cost must be non-negative');
  }
  if (prevRefundedMilli < 0 || refundMilli < 0) {
    throw new RangeError('refund quantities must be non-negative');
  }
  const next = prevRefundedMilli + refundMilli;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError('refunded quantity exceeds safe integer');
  }
  return subSafe(
    mulDivRound(next, unitCostSnapshot, 1000),
    mulDivRound(prevRefundedMilli, unitCostSnapshot, 1000),
  );
}

/** Tax share of a refunded line, cumulative so repeated refunds do not drift. */
export function refundedTax(
  taxAlloc: number,
  soldMilli: number,
  prevRefundedMilli: number,
  refundMilli: number,
): number {
  return cumulativeShare(taxAlloc, soldMilli, prevRefundedMilli, refundMilli);
}

function readMethod(method: RefundMethod | null | undefined): RefundMethod {
  if (method === undefined || method === null || method === 'cash') {
    return 'cash';
  }
  if (method === 'card' || method === 'bank_wallet') {
    return method;
  }
  throw new RangeError('refund method must be cash, card or bank_wallet');
}

/** Split a refund into a paid part and an udhaar part (07 §6.1, D-046). */
export function splitRefund(input: SplitRefundInput): SplitRefundResult {
  assertSafeInteger(input.exact, 'exact');
  assertSafeInteger(input.paid_total, 'paid_total');
  assertSafeInteger(input.udhaar_amount, 'udhaar_amount');
  if (input.exact < 0) {
    throw new RangeError('exact must be non-negative');
  }
  if (input.paid_total < 0 || input.udhaar_amount < 0) {
    throw new RangeError('paid and udhaar totals must be non-negative');
  }
  let remainingPaid = input.paid_total;
  let remainingUdhaar = input.udhaar_amount;
  for (const prior of input.prior_refunds ?? []) {
    assertSafeInteger(prior.amount, 'prior.amount');
    assertSafeInteger(prior.udhaar_part, 'prior.udhaar_part');
    remainingPaid = subSafe(remainingPaid, prior.amount);
    remainingUdhaar = subSafe(remainingUdhaar, prior.udhaar_part);
  }
  const paidCap = Math.max(remainingPaid, 0);
  const udhaarCap = Math.max(remainingUdhaar, 0);
  const overPaid = input.exact - paidCap;
  const udhaarPart = Math.min(Math.max(overPaid, 0), udhaarCap);
  const paidExact = input.exact - udhaarPart;
  if (paidExact === 0) {
    return {
      exact: input.exact,
      udhaar_part: udhaarPart,
      paid_exact: 0,
      method: null,
      amount: 0,
      rounding: 0,
    };
  }
  const method = readMethod(input.method);
  if (method !== 'cash') {
    return {
      exact: input.exact,
      udhaar_part: udhaarPart,
      paid_exact: paidExact,
      method,
      amount: paidExact,
      rounding: 0,
    };
  }
  const cash = roundCashRefund(
    paidExact,
    readRounding(input.refund_rounding),
    paidCap,
  );
  return {
    exact: input.exact,
    udhaar_part: udhaarPart,
    paid_exact: paidExact,
    method: 'cash',
    amount: cash.amount,
    rounding: cash.rounding,
  };
}
