import { describe, expect, it } from 'vitest';
import { nextAvgCost } from './cost.ts';
import { computeDayClose } from './dayClose.ts';
import { creditLimitCheck, oldestUnpaidAt, partyBalance } from './ledger.ts';
import {
  allocate,
  cashChips,
  mulDivRound,
  roundHalfAway,
  roundTo,
  subSafe,
  sumSafe,
} from './money.ts';
import { computePurchase } from './purchases.ts';
import {
  computeRefundLine,
  refundedCost,
  refundedRevenue,
  refundedTax,
  roundCashRefund,
  splitRefund,
} from './refunds.ts';
import {
  movementChangesAvgCost,
  onHandMilli,
  stockValuePaisa,
} from './stock.ts';
import { computeSupplierReturn } from './supplierReturns.ts';
import { computeCart, isBelowCost } from './totals.ts';

describe('mulDivRound and roundTo', () => {
  it('rounds half away from zero', () => {
    expect(mulDivRound(5, 1, 2)).toBe(3);
    expect(mulDivRound(-5, 1, 2)).toBe(-3);
    expect(mulDivRound(5, 1, -2)).toBe(-3);
    expect(mulDivRound(-5, 1, -2)).toBe(3);
    expect(mulDivRound(1, 1, 3)).toBe(0);
    expect(mulDivRound(1, 1, 2)).toBe(1);
    expect(mulDivRound(4, 1, 2)).toBe(2);
    expect(mulDivRound(0, 5, 3)).toBe(0);
  });

  it('rejects a zero divisor, non-integers and unsafe results', () => {
    expect(() => mulDivRound(1, 1, 0)).toThrow(RangeError);
    expect(() => roundHalfAway(1n, 0n)).toThrow(RangeError);
    expect(() => mulDivRound(1.5, 1, 1)).toThrow(RangeError);
    expect(() => mulDivRound(1, 1.5, 1)).toThrow(RangeError);
    expect(() => mulDivRound(1, 1, 1.5)).toThrow(RangeError);
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow(
      RangeError,
    );
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER + 1, 1, 1)).toThrow(
      RangeError,
    );
  });

  it('rounds to a step and rejects a bad step or an unsafe multiple', () => {
    expect(roundTo(427_215, 100)).toBe(427_200);
    expect(roundTo(-50, 100)).toBe(-100);
    expect(roundTo(-15, 100)).toBe(0);
    expect(roundTo(50, 100)).toBe(100);
    expect(() => roundTo(10, 0)).toThrow(RangeError);
    expect(() => roundTo(10, -100)).toThrow(RangeError);
    expect(() => roundTo(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
    expect(() => roundTo(1.2, 1)).toThrow(RangeError);
  });
});

describe('allocate', () => {
  it('uses the largest remainder and breaks ties toward the lower index', () => {
    expect(allocate(10_000, [10_000, 10_000, 10_000])).toEqual([
      3334, 3333, 3333,
    ]);
    expect(allocate(5, [1, 1, 1])).toEqual([2, 2, 1]);
    expect(allocate(-5, [1, 1, 1])).toEqual([-2, -2, -1]);
    expect(allocate(50_000, [4_000_000, 350_000])).toEqual([45_977, 4023]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(10, [0, 0])).toEqual([0, 0]);
    expect(allocate(7, [])).toEqual([]);
    expect(allocate(20, [0, 4])).toEqual([0, 20]);
  });

  it('rejects a negative or non-integer weight', () => {
    expect(() => allocate(1, [-1])).toThrow(RangeError);
    expect(() => allocate(1.5, [1])).toThrow(RangeError);
    expect(() => allocate(1, [1.5])).toThrow(RangeError);
  });
});

describe('cashChips', () => {
  it('matches the quick-cash vectors', () => {
    expect(cashChips(145_000)).toEqual([150_000, 200_000, 500_000]);
    expect(cashChips(4_000)).toEqual([50_000, 100_000, 500_000]);
    expect(cashChips(430_000)).toEqual([450_000, 500_000]);
    expect(cashChips(500_000)).toEqual([]);
    expect(cashChips(0)).toEqual([]);
    expect(cashChips(-100)).toEqual([]);
  });

  it('rejects a non-integer due amount', () => {
    expect(() => cashChips(1.5)).toThrow(RangeError);
  });

  it('never returns a chip outside the safe-integer range', () => {
    for (const chip of cashChips(Number.MAX_SAFE_INTEGER))
      expect(Number.isSafeInteger(chip)).toBe(true);
  });
});

describe('sumSafe and subSafe', () => {
  it('adds and subtracts integers', () => {
    expect(sumSafe([])).toBe(0);
    expect(sumSafe([1, -2, 3])).toBe(2);
    expect(subSafe(5, 8)).toBe(-3);
  });

  it('rejects non-integers and unsafe results', () => {
    expect(() => sumSafe([1.5])).toThrow(RangeError);
    expect(() => sumSafe([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
    expect(() => subSafe(1.5, 1)).toThrow(RangeError);
    expect(() => subSafe(Number.MAX_SAFE_INTEGER, -1)).toThrow(RangeError);
  });
});

describe('computeCart edges', () => {
  it('flags below-cost lines and leaves unknown cost alone', () => {
    const cart = computeCart({
      lines: [
        { qty_milli: 1000, unit_price: 10_000, avg_cost: 15_000 },
        { qty_milli: 1000, unit_price: 10_000, avg_cost: 10_000 },
        { qty_milli: 1000, unit_price: 10_000, avg_cost: 0 },
        {
          qty_milli: 1000,
          unit_price: 5_000,
          avg_cost: 1_000,
          last_cost: 8_000,
        },
        { qty_milli: 1000, unit_price: 1_000, unit_cost: 5_000 },
      ],
      cost_method: 'avg',
      round_total_to: 1,
      tax_rate_bp: 0,
    });
    expect(cart.lines.map((line) => line.below_cost)).toEqual([1, 0, 0, 0, 1]);
    const last = computeCart({
      lines: [
        {
          qty_milli: 1000,
          unit_price: 5_000,
          avg_cost: 1_000,
          last_cost: 8_000,
        },
        { qty_milli: 1000, unit_price: 9_000, last_cost: 1_000 },
        { qty_milli: 1000, unit_price: 9_000, unit_cost: 1_000 },
        { qty_milli: 1000, unit_price: 9_000 },
      ],
      cost_method: 'last',
      round_total_to: 1,
    });
    expect(last.lines.map((line) => line.below_cost)).toEqual([1, 0, 0, 0]);
  });

  it('caps percent and rupee discounts and a zero gross share', () => {
    const capped = computeCart({
      lines: [
        {
          qty_milli: 1000,
          unit_price: 10_000,
          discount_type: 'pct',
          discount_value: 25_000,
        },
        {
          qty_milli: 1000,
          unit_price: 8_000,
          discount_type: 'rs',
          discount_value: 0,
        },
        { qty_milli: 1000, unit_price: 0, discount_type: 'pct' },
      ],
      bill_discount: { type: 'pct', value: 20_000 },
      tax_rate_bp: 1700,
      tax_mode: 'exclusive',
      round_total_to: 100,
    });
    expect(capped.lines[0]?.discount).toBe(10_000);
    expect(capped.lines[1]?.discount).toBe(0);
    expect(capped.bill_discount).toBeLessThanOrEqual(capped.subtotal);
    const free = computeCart({
      lines: [{ qty_milli: 1000, unit_price: 0 }],
      bill_discount: { type: 'rs', value: 500 },
      tax_rate_bp: 1700,
      tax_mode: 'inclusive',
    });
    expect(free.discount_share_bp).toBe(0);
    expect(free.tax).toBe(0);
    expect(free.total).toBe(0);
    const wiped = computeCart({
      lines: [{ qty_milli: 1000, unit_price: 10_000 }],
      bill_discount: { type: 'rs', value: 50_000 },
      tax_rate_bp: 1700,
      tax_mode: 'exclusive',
      round_total_to: 1,
    });
    expect(wiped.bill_discount).toBe(10_000);
    expect(wiped.tax).toBe(0);
  });

  it('defaults a missing step, tax rate and discount value', () => {
    const cart = computeCart({
      lines: [{ qty_milli: 1000, unit_price: 15_050, discount_type: 'rs' }],
      tax_mode: 'exclusive',
      cost_method: 'avg',
    });
    expect(cart.total).toBe(15_100);
    expect(cart.lines[0]?.discount).toBe(0);
    expect(cart.discount_share_bp).toBe(0);
  });

  it('rejects bad cart inputs', () => {
    expect(() =>
      computeCart({
        lines: [
          { qty_milli: 1000, unit_price: 100, discount_type: 'nope' as 'rs' },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [{ qty_milli: 1000, unit_price: 100 }],
        bill_discount: { type: 'nope' as 'rs', value: 1 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [{ qty_milli: 0, unit_price: 100 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [{ qty_milli: 1000, unit_price: -1 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [
          {
            qty_milli: 1000,
            unit_price: 100,
            discount_type: 'rs',
            discount_value: -5,
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [{ qty_milli: 1000, unit_price: 100, avg_cost: -1 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [{ qty_milli: 1000, unit_price: 100 }],
        bill_discount: { type: 'rs', value: -1 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [],
        tax_mode: 'sideways' as 'exclusive',
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [],
        cost_method: 'fifo' as 'avg',
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [],
        tax_rate_bp: -1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeCart({
        lines: [
          { qty_milli: 1000, unit_price: Number.MAX_SAFE_INTEGER },
          { qty_milli: 1000, unit_price: Number.MAX_SAFE_INTEGER },
        ],
        round_total_to: 1,
      }),
    ).toThrow(RangeError);
    expect(() => isBelowCost(1.5, 1000, 1)).toThrow(RangeError);
    expect(isBelowCost(100, 1000, 0)).toBe(false);
    expect(isBelowCost(100, 1000, -5)).toBe(false);
    expect(isBelowCost(50, 1000, 100)).toBe(true);
    expect(isBelowCost(100, 1000, 100)).toBe(false);
  });
});

describe('refund edges', () => {
  it('rounds cash down, exact, and under the remaining-paid cap', () => {
    expect(roundCashRefund(6666, 'down')).toEqual({
      amount: 6600,
      rounding: -66,
    });
    expect(roundCashRefund(6666, 'none')).toEqual({
      amount: 6666,
      rounding: 0,
    });
    expect(roundCashRefund(0)).toEqual({ amount: 0, rounding: 0 });
    expect(roundCashRefund(6666, 'nearest', 100_000)).toEqual({
      amount: 6700,
      rounding: 34,
    });
    expect(roundCashRefund(250, 'nearest', 199)).toEqual({
      amount: 199,
      rounding: -51,
    });
    expect(roundCashRefund(50, 'nearest', 0)).toEqual({
      amount: 0,
      rounding: -50,
    });
    expect(roundCashRefund(50, 'nearest', -20)).toEqual({
      amount: 0,
      rounding: -50,
    });
    expect(roundCashRefund(250, 'none', 199)).toEqual({
      amount: 199,
      rounding: -51,
    });
    expect(roundCashRefund(6666, 'down', 10_000)).toEqual({
      amount: 6600,
      rounding: -66,
    });
  });

  it('keeps card and wallet paid parts exact and defaults the method to cash', () => {
    const card = splitRefund({
      exact: 6666,
      paid_total: 10_000,
      udhaar_amount: 10_000,
      method: 'card',
      refund_rounding: 'nearest',
    });
    expect(card).toMatchObject({
      method: 'card',
      amount: 6666,
      rounding: 0,
      udhaar_part: 0,
    });
    const wallet = splitRefund({
      exact: 5000,
      paid_total: 5000,
      udhaar_amount: 0,
      method: 'bank_wallet',
      refund_rounding: 'down',
    });
    expect(wallet).toMatchObject({
      method: 'bank_wallet',
      amount: 5000,
      rounding: 0,
    });
    const implied = splitRefund({
      exact: 100,
      paid_total: 100,
      udhaar_amount: 0,
    });
    expect(implied.method).toBe('cash');
    expect(implied.amount).toBe(100);
    const explicitNull = splitRefund({
      exact: 100,
      paid_total: 100,
      udhaar_amount: 0,
      method: null,
    });
    expect(explicitNull.method).toBe('cash');
    const khata = splitRefund({
      exact: 100,
      paid_total: 0,
      udhaar_amount: 100,
      method: 'card',
    });
    expect(khata.method).toBeNull();
    expect(khata.amount).toBe(0);
  });

  it('caps a card refund at the amount still paid after cash rounding', () => {
    const capped = splitRefund({
      exact: 6667,
      paid_total: 20000,
      udhaar_amount: 0,
      prior_refunds: [{ amount: 13400, udhaar_part: 0 }],
      method: 'card',
    });
    expect(capped).toMatchObject({
      paid_exact: 6667,
      method: 'card',
      amount: 6600,
      rounding: -67,
    });
  });

  it('refunds revenue, cost and tax without a paisa of drift', () => {
    const revenue = 427_215;
    const tax = 15_300;
    const cost = 80_000;
    let prev = 0;
    let revenueSum = 0;
    let taxSum = 0;
    let costSum = 0;
    for (let part = 0; part < 3; part += 1) {
      revenueSum += refundedRevenue(revenue, 3000, prev, 1000);
      taxSum += refundedTax(tax, 3000, prev, 1000);
      costSum += refundedCost(cost, prev, 1000);
      prev += 1000;
    }
    expect(revenueSum).toBe(revenue);
    expect(taxSum).toBe(tax);
    expect(costSum).toBe(refundedCost(cost, 0, 3000));
    expect(computeRefundLine(100, 10, 0, 0)).toBe(0);
  });

  it('rejects bad refund inputs', () => {
    expect(() => roundCashRefund(-1)).toThrow(RangeError);
    expect(() => roundCashRefund(10, 'sideways' as 'nearest')).toThrow(
      RangeError,
    );
    expect(() => roundCashRefund(10, 'nearest', 1.5)).toThrow(RangeError);
    expect(() => computeRefundLine(100, 0, 0, 1)).toThrow(RangeError);
    expect(() => computeRefundLine(100, 10, -1, 1)).toThrow(RangeError);
    expect(() => computeRefundLine(100, 10, 0, -1)).toThrow(RangeError);
    expect(() =>
      computeRefundLine(100, 10, Number.MAX_SAFE_INTEGER, 1),
    ).toThrow(RangeError);
    expect(() => refundedCost(-1, 0, 1)).toThrow(RangeError);
    expect(() => refundedCost(10, -1, 1)).toThrow(RangeError);
    expect(() => refundedCost(10, 0, -1)).toThrow(RangeError);
    expect(() => refundedCost(10, Number.MAX_SAFE_INTEGER, 1)).toThrow(
      RangeError,
    );
    expect(() =>
      splitRefund({ exact: -1, paid_total: 0, udhaar_amount: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      splitRefund({ exact: 1, paid_total: -1, udhaar_amount: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      splitRefund({ exact: 1, paid_total: 0, udhaar_amount: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      splitRefund({
        exact: 1,
        paid_total: 1,
        udhaar_amount: 0,
        method: 'voucher' as 'cash',
      }),
    ).toThrow(RangeError);
    expect(() =>
      splitRefund({
        exact: 1,
        paid_total: 1,
        udhaar_amount: 0,
        prior_refunds: [{ amount: 1.5, udhaar_part: 0 }],
      }),
    ).toThrow(RangeError);
  });
});

describe('nextAvgCost edges', () => {
  it('rejects a non-positive quantity or a negative cost', () => {
    expect(() =>
      nextAvgCost({
        on_hand_milli: 1000,
        avg_cost: 100,
        qty_milli: 0,
        unit_cost: 100,
      }),
    ).toThrow(RangeError);
    expect(() =>
      nextAvgCost({
        on_hand_milli: 1000,
        avg_cost: -1,
        qty_milli: 1000,
        unit_cost: 100,
      }),
    ).toThrow(RangeError);
    expect(() =>
      nextAvgCost({
        on_hand_milli: 1000,
        avg_cost: 100,
        qty_milli: 1000,
        unit_cost: -1,
      }),
    ).toThrow(RangeError);
  });
});

describe('computeDayClose edges', () => {
  it('reports an over drawer when pay-ins and pay-outs are both present', () => {
    const close = computeDayClose({
      opening_cash: 0,
      cash_sales: 0,
      udhaar_cash_in: 0,
      pay_ins: 5_000,
      supplier_cash_in: 0,
      cash_refunds: 0,
      cash_expenses: 0,
      supplier_cash_out: 0,
      pay_outs: 1_000,
      counted_cash: 5_000,
    });
    expect(close.expected_cash).toBe(4_000);
    expect(close.difference).toBe(1_000);
    expect(close.drawer).toBe('over');
  });

  it('rejects a non-integer component', () => {
    expect(() =>
      computeDayClose({
        opening_cash: 1.5,
        cash_sales: 0,
        udhaar_cash_in: 0,
        pay_ins: 0,
        supplier_cash_in: 0,
        cash_refunds: 0,
        cash_expenses: 0,
        supplier_cash_out: 0,
        pay_outs: 0,
        counted_cash: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('computePurchase', () => {
  it('allocates other charges by line total into landed unit cost', () => {
    const purchase = computePurchase(
      [
        { qty_milli: 2000, unit_cost: 100_000 },
        { qty_milli: 1000, unit_cost: 50_000 },
      ],
      30_000,
    );
    expect(purchase.lines).toEqual([
      {
        qty_milli: 2000,
        unit_cost: 100_000,
        line_total: 200_000,
        charges_alloc: 24_000,
        landed_unit_cost: 112_000,
      },
      {
        qty_milli: 1000,
        unit_cost: 50_000,
        line_total: 50_000,
        charges_alloc: 6_000,
        landed_unit_cost: 56_000,
      },
    ]);
    expect(purchase.goods_total).toBe(250_000);
    expect(purchase.total).toBe(280_000);
    const uneven = computePurchase(
      [
        { qty_milli: 1000, unit_cost: 100 },
        { qty_milli: 1000, unit_cost: 100 },
        { qty_milli: 1000, unit_cost: 100 },
      ],
      100,
    );
    expect(uneven.lines.map((line) => line.charges_alloc)).toEqual([
      34, 33, 33,
    ]);
  });

  it('leaves charges unallocated when every line total is zero', () => {
    const purchase = computePurchase(
      [
        { qty_milli: 1000, unit_cost: 0 },
        { qty_milli: 500, unit_cost: 0 },
      ],
      4_000,
    );
    expect(purchase.lines.map((line) => line.charges_alloc)).toEqual([0, 0]);
    expect(purchase.lines.map((line) => line.landed_unit_cost)).toEqual([0, 0]);
    expect(purchase.total).toBe(4_000);
    expect(computePurchase([], 0)).toEqual({
      lines: [],
      other_charges: 0,
      goods_total: 0,
      total: 0,
    });
  });

  it('rejects a bad purchase line', () => {
    expect(() => computePurchase([{ qty_milli: 0, unit_cost: 10 }], 0)).toThrow(
      RangeError,
    );
    expect(() =>
      computePurchase([{ qty_milli: 1000, unit_cost: -1 }], 0),
    ).toThrow(RangeError);
    expect(() => computePurchase([], -1)).toThrow(RangeError);
  });
});

describe('computeSupplierReturn edges', () => {
  it('uses last cost when the average is zero and honours an edited credit', () => {
    const fromLast = computeSupplierReturn({
      supplier_balance_before: 0,
      refund_received: 0,
      lines: [
        {
          qty_milli: 1000,
          avg_cost: 0,
          last_cost: 4_000,
          linked_landed_unit_cost: null,
        },
      ],
    });
    expect(fromLast.lines[0]?.unit_credit).toBe(4_000);
    expect(fromLast.suggested_refund).toBe(4_000);
    const edited = computeSupplierReturn({
      supplier_balance_before: 10_000,
      refund_received: 1_000,
      lines: [
        {
          qty_milli: 1000,
          avg_cost: 8_000,
          last_cost: 9_000,
          linked_landed_unit_cost: 7_000,
          unit_credit: 5_000,
        },
      ],
    });
    expect(edited.lines[0]).toMatchObject({
      unit_credit: 5_000,
      line_total: 5_000,
      cost_snapshot: 8_000,
      stock_delta_milli: -1000,
    });
    expect(edited.return_difference).toBe(-3_000);
    expect(edited.ledger).toEqual([-5_000, 1_000]);
    expect(edited.supplier_balance_after).toBe(6_000);
    const freeLink = computeSupplierReturn({
      supplier_balance_before: 100,
      refund_received: 0,
      lines: [
        {
          qty_milli: 1000,
          avg_cost: 50,
          last_cost: 80,
          linked_landed_unit_cost: 0,
          unit_credit: 100,
        },
      ],
    });
    expect(freeLink.lines[0]?.unit_credit).toBe(100);
  });

  it('rejects an empty, zero, or over-refunded return', () => {
    expect(() =>
      computeSupplierReturn({
        supplier_balance_before: 0,
        refund_received: 0,
        lines: [],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSupplierReturn({
        supplier_balance_before: 0,
        refund_received: -1,
        lines: [
          {
            qty_milli: 1000,
            avg_cost: 100,
            last_cost: 100,
            linked_landed_unit_cost: null,
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSupplierReturn({
        supplier_balance_before: 0,
        refund_received: 0,
        lines: [
          {
            qty_milli: 1000,
            avg_cost: 0,
            last_cost: 0,
            linked_landed_unit_cost: null,
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSupplierReturn({
        supplier_balance_before: 0,
        refund_received: 500,
        lines: [
          {
            qty_milli: 1000,
            avg_cost: 100,
            last_cost: 100,
            linked_landed_unit_cost: null,
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSupplierReturn({
        supplier_balance_before: 0,
        refund_received: 0,
        lines: [
          {
            qty_milli: 0,
            avg_cost: 100,
            last_cost: 100,
            linked_landed_unit_cost: null,
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSupplierReturn({
        supplier_balance_before: 0,
        refund_received: 0,
        lines: [
          {
            qty_milli: 1000,
            avg_cost: -1,
            last_cost: 100,
            linked_landed_unit_cost: null,
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSupplierReturn({
        supplier_balance_before: 0,
        refund_received: 0,
        lines: [
          {
            qty_milli: 1000,
            avg_cost: 100,
            last_cost: -1,
            linked_landed_unit_cost: null,
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSupplierReturn({
        supplier_balance_before: 0,
        refund_received: 0,
        lines: [
          {
            qty_milli: 1000,
            avg_cost: 100,
            last_cost: 100,
            linked_landed_unit_cost: -5,
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSupplierReturn({
        supplier_balance_before: 0,
        refund_received: 0,
        lines: [
          {
            qty_milli: 1000,
            avg_cost: 100,
            last_cost: 100,
            linked_landed_unit_cost: null,
            unit_credit: -1,
          },
        ],
      }),
    ).toThrow(RangeError);
  });
});

describe('ledger and stock', () => {
  it('sums a party balance', () => {
    expect(partyBalance([])).toBe(0);
    expect(partyBalance([5_000, -2_000, 100])).toBe(3_100);
    expect(() => partyBalance([Number.MAX_SAFE_INTEGER, 1])).toThrow(
      RangeError,
    );
  });

  it('ages the oldest uncovered debit and applies credit forward', () => {
    expect(oldestUnpaidAt([])).toBeNull();
    expect(
      oldestUnpaidAt([
        { amount: 100, created_at: 10 },
        { amount: -40, created_at: 20 },
        { amount: 50, created_at: 30 },
      ]),
    ).toBe(10);
    expect(
      oldestUnpaidAt([
        { amount: 100, created_at: 10 },
        { amount: -100, created_at: 20 },
      ]),
    ).toBeNull();
    expect(
      oldestUnpaidAt([
        { amount: -30, created_at: 5 },
        { amount: 10, created_at: 15 },
        { amount: 50, created_at: 15 },
      ]),
    ).toBe(15);
    expect(
      oldestUnpaidAt([
        { amount: 20, created_at: 1 },
        { amount: 20, created_at: 2 },
        { amount: -50, created_at: 3 },
      ]),
    ).toBeNull();
    expect(() => oldestUnpaidAt([{ amount: 0, created_at: 1 }])).toThrow(
      RangeError,
    );
  });

  it('warns and hard-blocks a credit limit', () => {
    expect(creditLimitCheck(1_000, 500, null, true)).toEqual({
      balance_after: 1_500,
      over_by: 0,
      over_limit: false,
      hard_blocked: false,
    });
    expect(creditLimitCheck(1_000, 500, 2_000, true)).toEqual({
      balance_after: 1_500,
      over_by: 0,
      over_limit: false,
      hard_blocked: false,
    });
    expect(creditLimitCheck(1_000, 500, 1_200, false)).toEqual({
      balance_after: 1_500,
      over_by: 300,
      over_limit: true,
      hard_blocked: false,
    });
    expect(creditLimitCheck(1_000, 500, 1_200, true).hard_blocked).toBe(true);
    expect(() =>
      creditLimitCheck(Number.MAX_SAFE_INTEGER, 1, null, false),
    ).toThrow(RangeError);
  });

  it('derives on-hand, stock value and which movements move average cost', () => {
    expect(onHandMilli([1000, -400, 50])).toBe(650);
    expect(
      stockValuePaisa([
        { on_hand_milli: 2500, avg_cost: 10_000, track_stock: 1 },
        { on_hand_milli: -500, avg_cost: 10_000, track_stock: true },
        { on_hand_milli: 0, avg_cost: 10_000, track_stock: 1 },
        { on_hand_milli: 9000, avg_cost: 10_000, track_stock: 0 },
        { on_hand_milli: 9000, avg_cost: 10_000, track_stock: false },
      ]),
    ).toBe(25_000);
    expect(() =>
      stockValuePaisa([{ on_hand_milli: 1000, avg_cost: -1, track_stock: 1 }]),
    ).toThrow(RangeError);
    expect(movementChangesAvgCost('purchase')).toBe(true);
    expect(movementChangesAvgCost('opening')).toBe(true);
    expect(movementChangesAvgCost('received_godown')).toBe(true);
    expect(movementChangesAvgCost('received_local')).toBe(true);
    expect(movementChangesAvgCost('received_other')).toBe(true);
    expect(movementChangesAvgCost('supplier_return')).toBe(false);
    expect(movementChangesAvgCost('sale')).toBe(false);
  });
});
