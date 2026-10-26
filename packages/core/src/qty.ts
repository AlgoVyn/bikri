import { normaliseNumericText } from './digits.ts';

export const INTEGER_QTY_UNITS = [
  'pc',
  'pair',
  'set',
  'box',
  'pack',
  'dozen',
] as const;

export const DECIMAL_QTY_UNITS = ['m', 'kg', 'g', 'l', 'ml'] as const;

export const QTY_UNITS = [...INTEGER_QTY_UNITS, ...DECIMAL_QTY_UNITS] as const;

export type QtyUnit = (typeof QTY_UNITS)[number];

const INTEGER = new Set<string>(INTEGER_QTY_UNITS);
const DECIMAL = new Set<string>(DECIMAL_QTY_UNITS);

export function isQtyUnit(unit: string): unit is QtyUnit {
  return INTEGER.has(unit) || DECIMAL.has(unit);
}

export function qtyAllowsDecimals(unit: string): boolean {
  return DECIMAL.has(unit);
}

/**
 * Parse a quantity field to milli-units.
 * pc/pair/set/box/pack/dozen are whole units. m/kg/g/l/ml allow 3 decimals.
 */
export function parseQtyToMilli(raw: string, unit: string): number | null {
  if (!isQtyUnit(unit)) {
    return null;
  }
  const text = normaliseNumericText(raw)
    .trim()
    .replaceAll(',', '')
    .replaceAll(' ', '');
  if (text === '') {
    return null;
  }
  const match = qtyAllowsDecimals(unit)
    ? /^(\d+)(?:\.(\d{0,3}))?$/.exec(text)
    : /^(\d+)$/.exec(text);
  if (match === null) {
    return null;
  }
  const whole = Number(match[1]);
  const fractionDigits = match[2] ?? '';
  if (!Number.isSafeInteger(whole)) {
    return null;
  }
  const fraction =
    fractionDigits.length === 0 ? 0 : Number(fractionDigits.padEnd(3, '0'));
  const milli = whole * 1000 + fraction;
  if (!Number.isSafeInteger(milli)) {
    return null;
  }
  return milli;
}

/** Display milli-units in the unit's scale, trimming trailing decimal zeros. */
export function formatQtyFromMilli(milli: number, unit: string): string {
  if (!Number.isInteger(milli)) {
    throw new Error('formatQtyFromMilli expects integer milli-units');
  }
  const negative = milli < 0;
  const absolute = Math.abs(milli);
  const whole = Math.trunc(absolute / 1000);
  const fraction = absolute % 1000;
  const sign = negative ? '-' : '';
  if (!qtyAllowsDecimals(unit) || fraction === 0) {
    return `${sign}${whole}`;
  }
  const fractionText = String(fraction).padStart(3, '0').replace(/0+$/u, '');
  return `${sign}${whole}.${fractionText}`;
}
