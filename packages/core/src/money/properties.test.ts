import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planBundleRefund, priceBundle } from './bundles.ts';
import { allocate } from './money.ts';
import type { RefundRounding } from './refunds.ts';
import { computeRefundLine, refundedRevenue, splitRefund } from './refunds.ts';
import type { CartLineInput, TaxMode } from './totals.ts';
import { computeCart } from './totals.ts';

const RUNS = 100;

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('money properties', () => {
  it('sums allocations to the amount whenever the weights are positive', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 200_000 }), {
          minLength: 0,
          maxLength: 20,
        }),
        (amount, weights) => {
          const shares = allocate(amount, weights);
          const weightSum = sum(weights);
          if (weightSum === 0) {
            expect(shares).toEqual(weights.map(() => 0));
            return;
          }
          expect(sum(shares)).toBe(amount);
          for (const share of shares) {
            expect(
              Math.sign(share) === 0 || Math.sign(share) === Math.sign(amount),
            ).toBe(true);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('sums line finals to the total in both tax modes and bounds rounding', () => {
    const lineArb = fc.record({
      qty_milli: fc.integer({ min: 1, max: 20_000 }),
      unit_price: fc.integer({ min: 0, max: 500_000 }),
      discount_kind: fc.constantFrom(
        'none' as const,
        'rs' as const,
        'pct' as const,
      ),
      discount_value: fc.integer({ min: 0, max: 800_000 }),
    });
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 0, maxLength: 6 }),
        fc.constantFrom('none' as const, 'rs' as const, 'pct' as const),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 4_000 }),
        fc.constantFrom('exclusive' as const, 'inclusive' as const),
        fc.constantFrom(1, 100, 500, 1000),
        (rawLines, billKind, billValue, taxRate, taxMode: TaxMode, step) => {
          const lines: CartLineInput[] = rawLines.map((line) => {
            if (line.discount_kind === 'none') {
              return { qty_milli: line.qty_milli, unit_price: line.unit_price };
            }
            return {
              qty_milli: line.qty_milli,
              unit_price: line.unit_price,
              discount_type: line.discount_kind,
              discount_value: line.discount_value,
            };
          });
          const result = computeCart({
            lines,
            bill_discount:
              billKind === 'none' ? null : { type: billKind, value: billValue },
            tax_rate_bp: taxRate,
            tax_mode: taxMode,
            round_total_to: step,
          });
          expect(sum(result.lines.map((line) => line.final))).toBe(
            result.total,
          );
          expect(
            sum(result.lines.map((line) => line.bill_discount_alloc)),
          ).toBe(result.bill_discount);
          expect(sum(result.lines.map((line) => line.tax_alloc))).toBe(
            result.tax,
          );
          expect(sum(result.lines.map((line) => line.rounding_alloc))).toBe(
            result.rounding,
          );
          expect(Math.abs(result.rounding) * 2).toBeLessThanOrEqual(step);
          const taxAdded = taxMode === 'inclusive' ? 0 : result.tax;
          expect(result.total).toBe(
            result.subtotal - result.bill_discount + taxAdded + result.rounding,
          );
          if (taxMode === 'inclusive') {
            expect(
              sum(result.lines.map((line) => line.revenue)) + result.tax,
            ).toBe(result.total - result.rounding);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('returns the line final when every unit is refunded in any split', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.array(fc.integer({ min: 1, max: 400 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (lineFinal, parts) => {
          const sold = sum(parts);
          let prev = 0;
          let refunded = 0;
          let revenue = 0;
          for (const qty of parts) {
            refunded += computeRefundLine(lineFinal, sold, prev, qty);
            revenue += refundedRevenue(lineFinal, sold, prev, qty);
            prev += qty;
          }
          expect(refunded).toBe(lineFinal);
          expect(revenue).toBe(lineFinal);
          expect(prev).toBe(sold);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('conserves every paisa of a bundle price across its component lines', () => {
    const componentArb = fc.record({
      qty_milli: fc.integer({ min: 1, max: 5_000 }),
      unit_cost: fc.integer({ min: 0, max: 1_000_000 }),
      unit_price: fc.integer({ min: 0, max: 1_000_000 }),
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.array(componentArb, { minLength: 1, maxLength: 10 }),
        (price, qty, components) => {
          const result = priceBundle({
            bundle_price: price,
            bundle_qty: qty,
            components,
          });
          expect(result.total_net).toBe(price * qty);
          expect(sum(result.lines.map((line) => line.net))).toBe(price * qty);
          expect(result.total_cost).toBe(
            sum(result.lines.map((line) => line.cost_total)),
          );
          for (const line of result.lines) {
            expect(line.qty_milli).toBeGreaterThan(0);
            expect(line.gross).toBe(line.net + line.discount);
            expect(line.unit_price).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('refunds whole bundles without losing a paisa across repeated calls', () => {
    const components = [
      { qty_per_bundle: 500, line_final: 72_000 },
      { qty_per_bundle: 1000, line_final: 48_000 },
      { qty_per_bundle: 250, line_final: 12_000 },
    ];
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (sold, priorSeed, refundSeed) => {
          const prior = priorSeed % (sold + 1);
          const remaining = sold - prior;
          fc.pre(remaining > 0);
          const count = 1 + (refundSeed % remaining);
          const result = planBundleRefund({
            bundle_qty: sold,
            prev_refunded_bundles: prior,
            refund_bundles: count,
            components,
          });
          expect(sum(result.lines.map((line) => line.amount))).toBe(
            result.exact_amount,
          );
          for (const [index, line] of result.lines.entries()) {
            expect(line.qty_milli).toBe(
              (components[index]?.qty_per_bundle ?? 0) * count,
            );
            expect(line.amount).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('keeps refund udhaar and cash within what the bill still has', () => {
    const modes: readonly RefundRounding[] = ['nearest', 'down', 'none'];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.array(fc.integer({ min: 1, max: 300 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.constantFrom(...modes),
        (lineFinal, parts, paidSeed, mode) => {
          const sold = sum(parts);
          const paid = lineFinal === 0 ? 0 : paidSeed % (lineFinal + 1);
          const udhaar = lineFinal - paid;
          const prior: { amount: number; udhaar_part: number }[] = [];
          let prev = 0;
          let udhaarSum = 0;
          let cashSum = 0;
          for (const qty of parts) {
            const exact = computeRefundLine(lineFinal, sold, prev, qty);
            prev += qty;
            const split = splitRefund({
              exact,
              paid_total: paid,
              udhaar_amount: udhaar,
              prior_refunds: prior,
              method: 'cash',
              refund_rounding: mode,
            });
            prior.push({
              amount: split.amount,
              udhaar_part: split.udhaar_part,
            });
            udhaarSum += split.udhaar_part;
            if (split.method === 'cash') {
              cashSum += split.amount;
            }
            expect(split.amount).toBe(
              split.exact - split.udhaar_part + split.rounding,
            );
            expect(split.udhaar_part <= split.exact).toBe(true);
            expect(split.method === null).toBe(split.paid_exact === 0);
          }
          expect(udhaarSum).toBeLessThanOrEqual(udhaar);
          expect(cashSum).toBeLessThanOrEqual(paid);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
