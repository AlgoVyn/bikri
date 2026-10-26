import {
  allocate,
  assertSafeInteger,
  mulDivRound,
  roundTo,
  sumSafe,
} from './money.ts';

export type DiscountType = 'rs' | 'pct';
export type TaxMode = 'exclusive' | 'inclusive';
export type CostMethod = 'avg' | 'last';

const MAX_RATE_BP = 10_000;

export interface CartLineInput {
  qty_milli: number;
  unit_price: number;
  discount_type?: DiscountType;
  discount_value?: number;
  /** Explicit unit cost when avg_cost / last_cost are not set. */
  unit_cost?: number;
  avg_cost?: number;
  last_cost?: number;
}

export interface BillDiscount {
  type: DiscountType;
  value: number;
}

export interface CartInput {
  lines: readonly CartLineInput[];
  bill_discount?: BillDiscount | null;
  tax_rate_bp?: number;
  tax_mode?: TaxMode;
  round_total_to?: number;
  cost_method?: CostMethod;
}

export interface CartLineResult {
  gross: number;
  discount: number;
  net: number;
  bill_discount_alloc: number;
  tax_alloc: number;
  rounding_alloc: number;
  final: number;
  revenue: number;
  below_cost: 0 | 1;
}

export interface CartResult {
  lines: CartLineResult[];
  gross_total: number;
  item_discount_total: number;
  subtotal: number;
  bill_discount: number;
  taxable: number;
  tax: number;
  rounding: number;
  total: number;
  discount_share_bp: number;
}

interface PricedLine {
  gross: number;
  discount: number;
  net: number;
  qty_milli: number;
  unitCost: number;
}

export function isBelowCost(
  revenue: number,
  qtyMilli: number,
  unitCost: number,
): boolean {
  assertSafeInteger(revenue, 'revenue');
  assertSafeInteger(qtyMilli, 'qtyMilli');
  assertSafeInteger(unitCost, 'unitCost');
  if (unitCost <= 0) {
    return false;
  }
  return revenue < mulDivRound(qtyMilli, unitCost, 1000);
}

function readTaxMode(mode: TaxMode | undefined): TaxMode {
  if (mode === undefined || mode === 'exclusive') {
    return 'exclusive';
  }
  if (mode === 'inclusive') {
    return 'inclusive';
  }
  throw new RangeError('tax_mode must be exclusive or inclusive');
}

function readCostMethod(method: CostMethod | undefined): CostMethod {
  if (method === undefined || method === 'avg') {
    return 'avg';
  }
  if (method === 'last') {
    return 'last';
  }
  throw new RangeError('cost_method must be avg or last');
}

function cappedRate(value: number): number {
  return Math.min(value, MAX_RATE_BP);
}

function lineDiscount(gross: number, line: CartLineInput): number {
  const type = line.discount_type;
  if (type === undefined) {
    return 0;
  }
  const value = line.discount_value ?? 0;
  assertSafeInteger(value, 'discount_value');
  if (value < 0) {
    throw new RangeError('discount_value must be non-negative');
  }
  if (type === 'rs') {
    return Math.min(value, gross);
  }
  if (type === 'pct') {
    return mulDivRound(gross, cappedRate(value), MAX_RATE_BP);
  }
  throw new RangeError('discount_type must be rs or pct');
}

function billDiscountAmount(
  subtotal: number,
  bill: BillDiscount | null | undefined,
): number {
  if (bill == null) {
    return 0;
  }
  assertSafeInteger(bill.value, 'bill_discount.value');
  if (bill.value < 0) {
    throw new RangeError('bill discount must be non-negative');
  }
  if (bill.type === 'rs') {
    return Math.min(bill.value, subtotal);
  }
  if (bill.type === 'pct') {
    return mulDivRound(subtotal, cappedRate(bill.value), MAX_RATE_BP);
  }
  throw new RangeError('bill discount type must be rs or pct');
}

function taxOn(taxable: number, rate: number, mode: TaxMode): number {
  if (rate === 0 || taxable === 0) {
    return 0;
  }
  if (mode === 'inclusive') {
    const exTax = mulDivRound(taxable, MAX_RATE_BP, MAX_RATE_BP + rate);
    return taxable - exTax;
  }
  return mulDivRound(taxable, rate, MAX_RATE_BP);
}

function resolvedUnitCost(line: CartLineInput, method: CostMethod): number {
  if (method === 'last') {
    return line.last_cost ?? line.unit_cost ?? 0;
  }
  return line.avg_cost ?? line.unit_cost ?? 0;
}

function priceLine(line: CartLineInput, method: CostMethod): PricedLine {
  assertSafeInteger(line.qty_milli, 'qty_milli');
  assertSafeInteger(line.unit_price, 'unit_price');
  if (line.qty_milli <= 0) {
    throw new RangeError('qty_milli must be positive');
  }
  if (line.unit_price < 0) {
    throw new RangeError('unit_price must be non-negative');
  }
  const gross = mulDivRound(line.qty_milli, line.unit_price, 1000);
  const discount = lineDiscount(gross, line);
  const unitCost = resolvedUnitCost(line, method);
  assertSafeInteger(unitCost, 'unit_cost');
  if (unitCost < 0) {
    throw new RangeError('unit cost must be non-negative');
  }
  return {
    gross,
    discount,
    net: gross - discount,
    qty_milli: line.qty_milli,
    unitCost,
  };
}

/** Cart totals, allocations, tax and below-cost flags (07 §2–§3). */
export function computeCart(input: CartInput): CartResult {
  const taxMode = readTaxMode(input.tax_mode);
  const costMethod = readCostMethod(input.cost_method);
  const step = input.round_total_to ?? 100;
  const taxRate = input.tax_rate_bp ?? 0;
  assertSafeInteger(step, 'round_total_to');
  assertSafeInteger(taxRate, 'tax_rate_bp');
  if (taxRate < 0) {
    throw new RangeError('tax_rate_bp must be non-negative');
  }

  const priced = input.lines.map((line) => priceLine(line, costMethod));
  const grossTotal = sumSafe(priced.map((line) => line.gross));
  const itemDiscountTotal = sumSafe(priced.map((line) => line.discount));
  const subtotal = sumSafe(priced.map((line) => line.net));
  const billDiscount = billDiscountAmount(subtotal, input.bill_discount);
  const taxable = subtotal - billDiscount;
  const tax = taxOn(taxable, taxRate, taxMode);
  const preRound = taxMode === 'inclusive' ? taxable : taxable + tax;
  const total = roundTo(preRound, step);
  const rounding = total - preRound;
  const nets = priced.map((line) => line.net);
  const billAlloc = allocate(billDiscount, nets);
  const taxAlloc = allocate(tax, nets);
  const roundingAlloc = allocate(rounding, nets);

  const lines: CartLineResult[] = priced.map((line, index) => {
    const billPart = billAlloc[index] as number;
    const taxPart = taxAlloc[index] as number;
    const roundPart = roundingAlloc[index] as number;
    const revenue =
      taxMode === 'inclusive'
        ? line.net - billPart - taxPart
        : line.net - billPart;
    const final =
      taxMode === 'inclusive'
        ? line.net - billPart + roundPart
        : line.net - billPart + taxPart + roundPart;
    return {
      gross: line.gross,
      discount: line.discount,
      net: line.net,
      bill_discount_alloc: billPart,
      tax_alloc: taxPart,
      rounding_alloc: roundPart,
      final,
      revenue,
      below_cost: isBelowCost(revenue, line.qty_milli, line.unitCost) ? 1 : 0,
    };
  });

  const discountShareBp =
    grossTotal === 0
      ? 0
      : mulDivRound(itemDiscountTotal + billDiscount, MAX_RATE_BP, grossTotal);

  return {
    lines,
    gross_total: grossTotal,
    item_discount_total: itemDiscountTotal,
    subtotal,
    bill_discount: billDiscount,
    taxable,
    tax,
    rounding,
    total,
    discount_share_bp: discountShareBp,
  };
}
