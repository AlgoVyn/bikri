import { allocate, assertSafeInteger, mulDivRound } from './money.ts';
import { computeRefundLine } from './refunds.ts';

export type BundleComponentInput = {
  /** Recipe quantity for one bundle, in milli-units. */
  qty_milli: number;
  /** Component unit cost (shop `cost_method`), paisa. */
  unit_cost: number;
  /** Component shelf price, paisa. */
  unit_price: number;
};

export type BundlePriceInput = {
  /** Bundle price for one bundle, paisa. */
  bundle_price: number;
  /** Positive whole number of bundles. */
  bundle_qty: number;
  components: readonly BundleComponentInput[];
};

export type BundlePriceLine = {
  qty_milli: number;
  unit_price: number;
  gross: number;
  discount: number;
  net: number;
  unit_cost: number;
  cost_total: number;
  below_cost: boolean;
};

export type BundlePriceResult = {
  lines: BundlePriceLine[];
  total_net: number;
  total_cost: number;
  below_cost: boolean;
  items_total: number;
  saving: number;
};

function ceilDiv(numerator: number, denominator: number): number {
  assertSafeInteger(numerator, 'numerator');
  assertSafeInteger(denominator, 'denominator');
  return Number(
    (BigInt(numerator) + BigInt(denominator) - 1n) / BigInt(denominator),
  );
}

/** Moves paisa from the largest surplus to lines below their component cost. */
function coverCosts(shares: number[], costs: readonly number[]): void {
  for (let index = 0; index < shares.length; index += 1) {
    const gap = (costs[index] as number) - (shares[index] as number);
    if (gap <= 0) continue;
    for (let moved = 0; moved < gap; moved += 1) {
      let donor = 0;
      for (let candidate = 1; candidate < shares.length; candidate += 1) {
        const surplus =
          (shares[candidate] as number) - (costs[candidate] as number);
        const best = (shares[donor] as number) - (costs[donor] as number);
        if (surplus > best) donor = candidate;
      }
      shares[donor] = (shares[donor] as number) - 1;
      shares[index] = (shares[index] as number) + 1;
    }
  }
}

/**
 * Cost-weighted split of a bundle price into one component line per recipe item
 * (07 §3.4). The bundle total is authoritative; component unit prices are internal
 * and may be below the component shelf price.
 */
export function priceBundle(input: BundlePriceInput): BundlePriceResult {
  const { bundle_price: price, bundle_qty: count, components } = input;
  assertSafeInteger(price, 'bundle_price');
  assertSafeInteger(count, 'bundle_qty');
  if (price < 0) throw new RangeError('bundle_price must be non-negative');
  if (count <= 0) throw new RangeError('bundle_qty must be positive');
  if (components.length === 0)
    throw new RangeError('a bundle needs at least one component');

  const quantities = components.map((component) => {
    assertSafeInteger(component.qty_milli, 'component qty_milli');
    assertSafeInteger(component.unit_cost, 'component unit_cost');
    assertSafeInteger(component.unit_price, 'component unit_price');
    if (component.qty_milli <= 0)
      throw new RangeError('component qty_milli must be positive');
    if (component.unit_cost < 0 || component.unit_price < 0)
      throw new RangeError('component prices must be non-negative');
    const qty = component.qty_milli * count;
    assertSafeInteger(qty, 'bundle component quantity');
    return qty;
  });

  const costs = components.map((component, index) =>
    mulDivRound(quantities[index] as number, component.unit_cost, 1000),
  );
  const totalCost = costs.reduce((sum, cost) => sum + cost, 0);
  const revenue = price * count;
  assertSafeInteger(revenue, 'bundle revenue');

  // Cost-weighted, then shelf price, then plain quantity for an all-free recipe.
  let weights = components.map(
    (component, index) => (quantities[index] as number) * component.unit_cost,
  );
  if (weights.every((weight) => weight === 0)) {
    weights = components.map(
      (component, index) =>
        (quantities[index] as number) * component.unit_price,
    );
  }
  if (weights.every((weight) => weight === 0)) {
    weights = quantities.slice();
  }

  const shares = allocate(revenue, weights);

  // A profitable bundle must not show a false below-cost line because of rounding.
  // Move paisa from the largest surplus to a line below its cost until every line
  // covers its own cost. A genuinely below-cost bundle keeps the weighted split.
  if (revenue >= totalCost) coverCosts(shares, costs);

  let totalNet = 0;
  let itemsTotal = 0;
  let belowCost = false;
  const lines = components.map((component, index): BundlePriceLine => {
    const qty = quantities[index] as number;
    const net = shares[index] as number;
    const cost = costs[index] as number;
    const unitPrice = ceilDiv(net * 1000, qty);
    const gross = mulDivRound(qty, unitPrice, 1000);
    const discount = gross - net;
    const lineBelow = net < cost;
    belowCost ||= lineBelow;
    totalNet += net;
    itemsTotal += mulDivRound(qty, component.unit_price, 1000);
    return {
      qty_milli: qty,
      unit_price: unitPrice,
      gross,
      discount,
      net,
      unit_cost: component.unit_cost,
      cost_total: cost,
      below_cost: lineBelow,
    };
  });

  return {
    lines,
    total_net: totalNet,
    total_cost: totalCost,
    below_cost: belowCost,
    items_total: itemsTotal,
    saving: itemsTotal - revenue,
  };
}

export type BundleRefundComponentInput = {
  /** Recipe quantity for one bundle, in milli-units. */
  qty_per_bundle: number;
  /** The sale line's final amount after bill discount, tax and rounding. */
  line_final: number;
};

export type BundleRefundInput = {
  bundle_qty: number;
  prev_refunded_bundles: number;
  refund_bundles: number;
  components: readonly BundleRefundComponentInput[];
};

export type BundleRefundLine = {
  qty_milli: number;
  amount: number;
};

export type BundleRefundResult = {
  lines: BundleRefundLine[];
  exact_amount: number;
};

/**
 * Whole-bundle refund quantities and amounts (07 §6.2). Every component line is
 * refunded with the same `k` whole bundles and its amount uses the cumulative
 * per-line formula, so repeated whole-bundle returns never drift by a paisa.
 */
export function planBundleRefund(input: BundleRefundInput): BundleRefundResult {
  const {
    bundle_qty: sold,
    prev_refunded_bundles: prior,
    refund_bundles: count,
    components,
  } = input;
  for (const [value, label] of [
    [sold, 'bundle_qty'],
    [prior, 'prev_refunded_bundles'],
    [count, 'refund_bundles'],
  ] as const) {
    assertSafeInteger(value, label);
  }
  if (sold <= 0) throw new RangeError('bundle_qty must be positive');
  if (prior < 0 || prior > sold)
    throw new RangeError('prev_refunded_bundles is out of range');
  if (count <= 0 || count > sold - prior)
    throw new RangeError('refund_bundles is out of range');
  if (components.length === 0)
    throw new RangeError('a bundle needs at least one component');

  let exact = 0;
  const lines = components.map((component): BundleRefundLine => {
    assertSafeInteger(component.qty_per_bundle, 'qty_per_bundle');
    assertSafeInteger(component.line_final, 'line_final');
    if (component.qty_per_bundle <= 0)
      throw new RangeError('qty_per_bundle must be positive');
    if (component.line_final < 0)
      throw new RangeError('line_final must be non-negative');
    const soldMilli = component.qty_per_bundle * sold;
    const priorMilli = component.qty_per_bundle * prior;
    const refundMilli = component.qty_per_bundle * count;
    const amount = computeRefundLine(
      component.line_final,
      soldMilli,
      priorMilli,
      refundMilli,
    );
    exact += amount;
    return { qty_milli: refundMilli, amount };
  });
  return { lines, exact_amount: exact };
}
