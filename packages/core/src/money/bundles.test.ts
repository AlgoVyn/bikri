import { describe, expect, it } from 'vitest';
import { coverCosts, planBundleRefund, priceBundle } from './bundles.ts';

describe('priceBundle', () => {
  it('lifts a rounding deficit up to the component cost', () => {
    const result = priceBundle({
      bundle_price: 95,
      bundle_qty: 1,
      components: [
        { qty_milli: 629, unit_cost: 44, unit_price: 44 },
        { qty_milli: 387, unit_cost: 22, unit_price: 22 },
        { qty_milli: 788, unit_cost: 74, unit_price: 74 },
      ],
    });
    expect(result.lines.map((line) => line.net)).toEqual([28, 9, 58]);
    expect(result.lines.every((line) => line.below_cost === false)).toBe(true);
    expect(result.total_net).toBe(95);
  });

  it('leaves shares untouched when every line is below cost', () => {
    const shares = [0, 1];
    coverCosts(shares, [10, 10]);
    expect(shares).toEqual([0, 1]);
  });

  it('keeps below-cost lines when no line has surplus to donate', () => {
    const result = priceBundle({
      bundle_price: 1,
      bundle_qty: 1,
      components: [
        { qty_milli: 1000, unit_cost: 100, unit_price: 100 },
        { qty_milli: 1000, unit_cost: 100, unit_price: 100 },
      ],
    });
    expect(result.total_net).toBe(1);
    expect(result.lines.every((line) => line.below_cost)).toBe(true);
  });

  it('handles a one-component bundle', () => {
    const result = priceBundle({
      bundle_price: 1000,
      bundle_qty: 2,
      components: [{ qty_milli: 1000, unit_cost: 300, unit_price: 500 }],
    });
    expect(result.lines).toEqual([
      {
        qty_milli: 2000,
        unit_price: 1000,
        gross: 2000,
        discount: 0,
        net: 2000,
        unit_cost: 300,
        cost_total: 600,
        below_cost: false,
      },
    ]);
    expect(result.saving).toBe(-1000);
  });

  it('falls back from cost to shelf price and then to quantity', () => {
    const shelf = priceBundle({
      bundle_price: 100,
      bundle_qty: 1,
      components: [
        { qty_milli: 1000, unit_cost: 0, unit_price: 3 },
        { qty_milli: 1000, unit_cost: 0, unit_price: 1 },
      ],
    });
    expect(shelf.lines.map((line) => line.net)).toEqual([75, 25]);
    const plain = priceBundle({
      bundle_price: 9,
      bundle_qty: 1,
      components: [
        { qty_milli: 2000, unit_cost: 0, unit_price: 0 },
        { qty_milli: 1000, unit_cost: 0, unit_price: 0 },
      ],
    });
    expect(plain.lines.map((line) => line.net)).toEqual([6, 3]);
  });

  it('handles a cost weight that exceeds the JS safe-integer range', () => {
    const result = priceBundle({
      bundle_price: 1_000,
      bundle_qty: 1,
      components: [
        {
          qty_milli: 10_000_000,
          unit_cost: 1_000_000_000,
          unit_price: 0,
        },
      ],
    });
    expect(result.total_net).toBe(1_000);
    expect(result.lines[0]?.net).toBe(1_000);
    expect(result.lines[0]?.below_cost).toBe(true);
  });

  it('rejects a unit price that would overflow the safe-integer range', () => {
    expect(() =>
      priceBundle({
        bundle_price: Number.MAX_SAFE_INTEGER,
        bundle_qty: 1,
        components: [
          { qty_milli: 1, unit_cost: 0, unit_price: Number.MAX_SAFE_INTEGER },
        ],
      }),
    ).toThrow(/safe integer/);
  });

  it('rejects malformed input', () => {
    const component = { qty_milli: 1000, unit_cost: 1, unit_price: 1 };
    expect(() =>
      priceBundle({
        bundle_price: -1,
        bundle_qty: 1,
        components: [component],
      }),
    ).toThrow(RangeError);
    expect(() =>
      priceBundle({ bundle_price: 1, bundle_qty: 0, components: [component] }),
    ).toThrow(RangeError);
    expect(() =>
      priceBundle({ bundle_price: 1, bundle_qty: 1, components: [] }),
    ).toThrow(RangeError);
    expect(() =>
      priceBundle({
        bundle_price: 1,
        bundle_qty: 1,
        components: [{ ...component, qty_milli: 0 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      priceBundle({
        bundle_price: 1,
        bundle_qty: 1,
        components: [{ ...component, unit_cost: -1 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      priceBundle({
        bundle_price: 1,
        bundle_qty: 1,
        components: [{ ...component, unit_cost: 1.5 }],
      }),
    ).toThrow(RangeError);
  });
});

describe('planBundleRefund', () => {
  const components = [
    { qty_per_bundle: 1000, line_final: 72000 },
    { qty_per_bundle: 1000, line_final: 48000 },
  ];

  it('rejects a component quantity product beyond the safe-integer range', () => {
    expect(() =>
      planBundleRefund({
        bundle_qty: 1_000_000_000,
        prev_refunded_bundles: 0,
        refund_bundles: 1,
        components: [{ qty_per_bundle: 10_000_000, line_final: 1_000 }],
      }),
    ).toThrow(/sold component quantity/);
  });

  it('rejects out-of-range bundle counts', () => {
    const base = {
      bundle_qty: 3,
      prev_refunded_bundles: 0,
      refund_bundles: 1,
      components,
    };
    expect(() => planBundleRefund({ ...base, bundle_qty: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      planBundleRefund({ ...base, prev_refunded_bundles: 4 }),
    ).toThrow(RangeError);
    expect(() => planBundleRefund({ ...base, refund_bundles: 0 })).toThrow(
      RangeError,
    );
    expect(() => planBundleRefund({ ...base, refund_bundles: 4 })).toThrow(
      RangeError,
    );
    expect(() => planBundleRefund({ ...base, components: [] })).toThrow(
      RangeError,
    );
    expect(() =>
      planBundleRefund({
        ...base,
        components: [{ qty_per_bundle: 0, line_final: 1 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      planBundleRefund({
        ...base,
        components: [{ qty_per_bundle: 1000, line_final: -1 }],
      }),
    ).toThrow(RangeError);
  });
});
