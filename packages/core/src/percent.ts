import { normaliseNumericText } from './digits.ts';

/**
 * Parse a percentage field to basis points without floating-point multiplication.
 * Accepts an optional sign, Urdu/Arabic-Indic digits, a trailing `%`, and up to
 * three decimals (the third only rounds the hundredth). Returns null for junk.
 */
export function parsePercentToBp(raw: string): number | null {
  const text = normaliseNumericText(raw)
    .trim()
    .replace('\u2212', '-')
    .replace('%', '')
    .replaceAll(',', '')
    .replaceAll(' ', '');
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/u.exec(text);
  if (match === null) return null;
  const whole = match[2] ?? '';
  const fraction = match[3] ?? '';
  if (whole === '' && fraction === '') return null;
  const integer = Number(whole || '0');
  if (!Number.isSafeInteger(integer)) return null;
  const hundredths = Number(`${fraction}00`.slice(0, 2));
  const roundUp = Number(fraction.slice(2, 3) || '0') >= 5;
  const bp = integer * 100 + hundredths + (roundUp ? 1 : 0);
  return match[1] === '-' ? -bp : bp;
}
