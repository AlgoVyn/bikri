import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nextAvgCost } from './cost.ts';
import { computeDayClose } from './dayClose.ts';
import type { PriorRefund, RefundMethod, RefundRounding } from './refunds.ts';
import { computeRefundLine, roundCashRefund, splitRefund } from './refunds.ts';
import type { SupplierReturnLineInput } from './supplierReturns.ts';
import { computeSupplierReturn } from './supplierReturns.ts';
import type {
  CartInput,
  CartLineInput,
  CartLineResult,
  CartResult,
  TaxMode,
} from './totals.ts';
import { computeCart } from './totals.ts';

/**
 * Doc 10 names packages/core/money/vectors.test.ts.
 * This package's Vitest include is only under src, so the vectors live here (D-064).
 * Every docs/fixtures/money-*.json file is loaded.
 */
const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/fixtures',
);

const REQUIRED_IDS: Record<string, readonly string[]> = {
  'money-totals.json': [
    'T1',
    'T2',
    'T3',
    'T4',
    'T5',
    'T6',
    'T7',
    'T8',
    'T9',
    'T10',
  ],
  'money-refunds.json': [
    'R1',
    'R2',
    'R3',
    'R4',
    'R5',
    'R6',
    'R7',
    'R8',
    'R9',
    'R10',
  ],
  'money-cost.json': ['C1', 'C2', 'C3', 'C4'],
  'money-dayclose.json': ['D1', 'D2', 'D3'],
  'money-supplier-returns.json': ['S1', 'S2', 'S3'],
};

interface IndexedSale {
  lines: readonly CartLineInput[];
  result: CartResult;
}

const sales = new Map<string, IndexedSale>();

function readCases(fileName: string): unknown[] {
  const parsed: unknown = JSON.parse(
    readFileSync(join(fixturesDir, fileName), 'utf8'),
  ) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${fileName} must be a JSON array`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function num(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function caseId(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error('fixture case is missing a name');
  }
  const id = /^([A-Z]+\d+)\b/.exec(name)?.[1];
  if (id === undefined) {
    throw new Error(`fixture case name has no id: ${name}`);
  }
  return id;
}

function expectFields(actual: unknown, expected: unknown, path: string): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    if (!Array.isArray(actual)) {
      return;
    }
    expect(actual, path).toHaveLength(expected.length);
    expected.forEach((item, index) => {
      expectFields(actual[index], item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    expect(actual, path).toEqual(expect.any(Object));
    if (typeof actual !== 'object' || actual === null) {
      return;
    }
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expectFields(actualRecord[key], value, `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function parseDiscountType(value: unknown, label: string): 'rs' | 'pct' {
  if (value === 'rs' || value === 'pct') {
    return value;
  }
  throw new Error(`${label} must be rs or pct`);
}

function parseTaxMode(value: unknown): TaxMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'exclusive' || value === 'inclusive') {
    return value;
  }
  throw new Error('tax_mode must be exclusive or inclusive');
}

function parseCartLine(value: unknown, index: number): CartLineInput {
  const line = record(value, `line ${index}`);
  const parsed: CartLineInput = {
    qty_milli: num(line.qty_milli, `lines[${index}].qty_milli`),
    unit_price: num(line.unit_price, `lines[${index}].unit_price`),
  };
  if (line.discount_type !== undefined) {
    parsed.discount_type = parseDiscountType(
      line.discount_type,
      `lines[${index}]`,
    );
    parsed.discount_value = num(
      line.discount_value,
      `lines[${index}].discount_value`,
    );
  }
  return parsed;
}

function parseBill(value: unknown): CartInput['bill_discount'] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const bill = record(value, 'bill_discount');
  return {
    type: parseDiscountType(bill.type, 'bill_discount'),
    value: num(bill.value, 'bill_discount.value'),
  };
}

function parseCart(value: unknown): CartInput {
  const input = record(value, 'input');
  if (!Array.isArray(input.lines)) {
    throw new Error('input.lines must be an array');
  }
  return {
    lines: input.lines.map((line, index) => parseCartLine(line, index)),
    bill_discount: parseBill(input.bill_discount),
    tax_rate_bp: num(input.tax_rate_bp, 'tax_rate_bp'),
    tax_mode: parseTaxMode(input.tax_mode),
    round_total_to: num(input.round_total_to, 'round_total_to'),
  };
}

function requireSale(id: string): IndexedSale {
  const sale = sales.get(id);
  if (sale === undefined) {
    throw new Error(`refund references unknown sale ${id}`);
  }
  return sale;
}

function requireLine(
  sale: IndexedSale,
  lineNo: number,
): { input: CartLineInput; result: CartLineResult } {
  const input = sale.lines[lineNo];
  const result = sale.result.lines[lineNo];
  if (input === undefined || result === undefined) {
    throw new Error(`missing sale line ${lineNo}`);
  }
  return { input, result };
}

function parseMethod(value: unknown): RefundMethod | null {
  if (value === null) {
    return null;
  }
  if (value === 'cash' || value === 'card' || value === 'bank_wallet') {
    return value;
  }
  throw new Error('refund method is invalid');
}

function parseRounding(value: unknown): RefundRounding {
  if (value === 'nearest' || value === 'down' || value === 'none') {
    return value;
  }
  throw new Error('refund_rounding is invalid');
}

function parsePriors(value: unknown): PriorRefund[] {
  if (!Array.isArray(value)) {
    throw new Error('prior_refunds must be an array');
  }
  return value.map((item, index) => {
    const prior = record(item, `prior_refunds[${index}]`);
    return {
      amount: num(prior.amount, `prior_refunds[${index}].amount`),
      udhaar_part: num(
        prior.udhaar_part,
        `prior_refunds[${index}].udhaar_part`,
      ),
    };
  });
}

function parseSupplierLine(
  value: unknown,
  index: number,
): SupplierReturnLineInput {
  const line = record(value, `lines[${index}]`);
  const linked = line.linked_landed_unit_cost;
  if (
    linked !== null &&
    (typeof linked !== 'number' || !Number.isInteger(linked))
  ) {
    throw new Error(
      `lines[${index}].linked_landed_unit_cost must be an integer or null`,
    );
  }
  return {
    qty_milli: num(line.qty_milli, `lines[${index}].qty_milli`),
    avg_cost: num(line.avg_cost, `lines[${index}].avg_cost`),
    last_cost: num(line.last_cost, `lines[${index}].last_cost`),
    linked_landed_unit_cost: linked,
  };
}

function indexSales(cases: unknown[]): void {
  for (const entry of cases) {
    const row = record(entry, 'totals case');
    const input = parseCart(row.input);
    sales.set(caseId(row.name), {
      lines: input.lines,
      result: computeCart(input),
    });
  }
}

function registerTotals(cases: unknown[]): void {
  for (const entry of cases) {
    const row = record(entry, 'totals case');
    const id = caseId(row.name);
    const input = parseCart(row.input);
    it(`${id} ${String(row.name)}`, () => {
      const actual = computeCart(input);
      expectFields(actual, row.expected, id);
      const taxAdded = input.tax_mode === 'inclusive' ? 0 : actual.tax;
      expect(actual.total).toBe(
        actual.subtotal - actual.bill_discount + taxAdded + actual.rounding,
      );
      expect(sum(actual.lines.map((line) => line.final))).toBe(actual.total);
      expect(sum(actual.lines.map((line) => line.gross))).toBe(
        actual.gross_total,
      );
      expect(sum(actual.lines.map((line) => line.discount))).toBe(
        actual.item_discount_total,
      );
      expect(sum(actual.lines.map((line) => line.net))).toBe(actual.subtotal);
      expect(sum(actual.lines.map((line) => line.bill_discount_alloc))).toBe(
        actual.bill_discount,
      );
      expect(sum(actual.lines.map((line) => line.tax_alloc))).toBe(actual.tax);
      expect(sum(actual.lines.map((line) => line.rounding_alloc))).toBe(
        actual.rounding,
      );
      for (const line of actual.lines) {
        expect(line.net).toBe(line.gross - line.discount);
      }
      if (input.tax_mode === 'inclusive') {
        expect(sum(actual.lines.map((line) => line.revenue)) + actual.tax).toBe(
          actual.total - actual.rounding,
        );
      }
    });
  }
}

function registerRefunds(cases: unknown[]): void {
  for (const entry of cases) {
    const row = record(entry, 'refund case');
    const id = caseId(row.name);
    it(`${id} ${String(row.name)}`, () => {
      const sale = requireSale(String(row.sale));
      if ('parts_exact' in row) {
        const { input, result } = requireLine(sale, num(row.line, 'line'));
        const parts = row.parts_exact;
        if (!Array.isArray(parts) || parts.length === 0) {
          throw new Error(`${id} parts_exact must be a non-empty array`);
        }
        const expectedParts = parts.map((part, index) =>
          num(part, `parts_exact[${index}]`),
        );
        if (input.qty_milli % expectedParts.length !== 0) {
          throw new Error(
            `${id} line qty ${input.qty_milli} is not divisible by ${expectedParts.length} refund parts`,
          );
        }
        const each = input.qty_milli / expectedParts.length;
        expect(result.final).toBe(num(row.line_final, 'line_final'));
        let prev = 0;
        const got: number[] = [];
        for (const expectedPart of expectedParts) {
          const amount = computeRefundLine(
            result.final,
            input.qty_milli,
            prev,
            each,
          );
          const cash = roundCashRefund(amount);
          expect(cash.rounding).toBe(cash.amount - amount);
          expect(amount).toBe(expectedPart);
          got.push(amount);
          prev += each;
        }
        expect(sum(got)).toBe(num(row.sum, 'sum'));
        expect(prev).toBe(input.qty_milli);
        return;
      }
      if ('expected' in row) {
        if (!Array.isArray(row.lines)) {
          throw new Error(`${id} lines must be an array`);
        }
        let exact = 0;
        for (const item of row.lines) {
          const lineRef = record(item, `${id} line`);
          const { input, result } = requireLine(
            sale,
            num(lineRef.line, 'line'),
          );
          const sold = num(lineRef.sold_milli, 'sold_milli');
          expect(input.qty_milli).toBe(sold);
          exact += computeRefundLine(
            result.final,
            sold,
            num(lineRef.prev_refunded_milli, 'prev_refunded_milli'),
            num(lineRef.refund_milli, 'refund_milli'),
          );
        }
        const split = splitRefund({
          exact,
          paid_total: num(row.paid_total, 'paid_total'),
          udhaar_amount: num(row.udhaar_amount, 'udhaar_amount'),
          prior_refunds: parsePriors(row.prior_refunds),
          method: parseMethod(row.method),
          refund_rounding: parseRounding(row.refund_rounding),
        });
        expect(split).toEqual(row.expected);
        expect(split.amount).toBe(
          split.exact - split.udhaar_part + split.rounding,
        );
        expect(split.method === null).toBe(split.paid_exact === 0);
        expect(split.udhaar_part).toBeLessThanOrEqual(split.exact);
        expect(split.amount).toBeGreaterThanOrEqual(0);
        return;
      }
      const { input, result } = requireLine(sale, num(row.line, 'line'));
      const sold = num(row.sold_milli, 'sold_milli');
      expect(input.qty_milli).toBe(sold);
      const exact = computeRefundLine(
        result.final,
        sold,
        num(row.prev_refunded_milli, 'prev_refunded_milli'),
        num(row.refund_milli, 'refund_milli'),
      );
      expect(exact).toBe(num(row.exact, 'exact'));
      const cash = roundCashRefund(exact);
      expect(cash.amount).toBe(num(row.cash_rounded, 'cash_rounded'));
      expect(cash.rounding).toBe(cash.amount - exact);
    });
  }
}

function registerCost(cases: unknown[]): void {
  for (const entry of cases) {
    const row = record(entry, 'cost case');
    const id = caseId(row.name);
    it(`${id} ${String(row.name)}`, () => {
      expect(
        nextAvgCost({
          on_hand_milli: num(row.on_hand_milli, 'on_hand_milli'),
          avg_cost: num(row.avg_cost, 'avg_cost'),
          qty_milli: num(row.qty_milli, 'qty_milli'),
          unit_cost: num(row.unit_cost, 'unit_cost'),
        }),
      ).toBe(num(row.expected_avg_cost, 'expected_avg_cost'));
    });
  }
}

function registerDayClose(cases: unknown[]): void {
  for (const entry of cases) {
    const row = record(entry, 'day close case');
    const id = caseId(row.name);
    it(`${id} ${String(row.name)}`, () => {
      const actual = computeDayClose({
        opening_cash: num(row.opening_cash, 'opening_cash'),
        cash_sales: num(row.cash_sales, 'cash_sales'),
        udhaar_cash_in: num(row.udhaar_cash_in, 'udhaar_cash_in'),
        pay_ins: num(row.pay_ins, 'pay_ins'),
        supplier_cash_in: num(row.supplier_cash_in, 'supplier_cash_in'),
        cash_refunds: num(row.cash_refunds, 'cash_refunds'),
        cash_expenses: num(row.cash_expenses, 'cash_expenses'),
        supplier_cash_out: num(row.supplier_cash_out, 'supplier_cash_out'),
        pay_outs: num(row.pay_outs, 'pay_outs'),
        counted_cash: num(row.counted_cash, 'counted_cash'),
      });
      const expected: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (key !== 'name') {
          expected[key] = value;
        }
      }
      expectFields(actual, expected, id);
    });
  }
}

function registerSupplierReturns(cases: unknown[]): void {
  for (const entry of cases) {
    const row = record(entry, 'supplier return case');
    const id = caseId(row.name);
    it(`${id} ${String(row.name)}`, () => {
      if (!Array.isArray(row.lines)) {
        throw new Error(`${id} lines must be an array`);
      }
      const actual = computeSupplierReturn({
        supplier_balance_before: num(
          row.supplier_balance_before,
          'supplier_balance_before',
        ),
        lines: row.lines.map((line, index) => parseSupplierLine(line, index)),
        refund_received: num(row.refund_received, 'refund_received'),
      });
      expectFields(actual, row.expected, id);
    });
  }
}

const handlers: Record<string, (cases: unknown[]) => void> = {
  'money-totals.json': registerTotals,
  'money-refunds.json': registerRefunds,
  'money-cost.json': registerCost,
  'money-dayclose.json': registerDayClose,
  'money-supplier-returns.json': registerSupplierReturns,
};

const moneyFiles = readdirSync(fixturesDir)
  .filter((name) => name.startsWith('money-') && name.endsWith('.json'))
  .sort();

if (moneyFiles.includes('money-totals.json')) {
  indexSales(readCases('money-totals.json'));
}

describe('money fixture vectors', () => {
  for (const fileName of moneyFiles) {
    const handler = handlers[fileName];
    if (handler === undefined) {
      it(`${fileName} has assertions`, () => {
        throw new Error(`no assertions implemented for ${fileName}`);
      });
      continue;
    }
    describe(fileName, () => {
      handler(readCases(fileName));
    });
  }

  it('includes every required case id', () => {
    expect(moneyFiles.length).toBeGreaterThan(0);
    for (const [fileName, ids] of Object.entries(REQUIRED_IDS)) {
      expect(moneyFiles, fileName).toContain(fileName);
      const present = readCases(fileName).map((entry) =>
        caseId(record(entry, fileName).name),
      );
      expect(present, fileName).toEqual(expect.arrayContaining([...ids]));
      for (const id of ids) {
        expect(present, `${fileName} ${id}`).toContain(id);
      }
    }
  });

  it('has unique case ids', () => {
    const seen = new Set<string>();
    for (const fileName of moneyFiles) {
      if (handlers[fileName] === undefined) {
        continue;
      }
      for (const entry of readCases(fileName)) {
        const id = caseId(record(entry, fileName).name);
        expect(seen.has(id), id).toBe(false);
        seen.add(id);
      }
    }
  });
});
