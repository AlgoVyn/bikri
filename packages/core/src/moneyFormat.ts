import { normaliseNumericText } from './digits.ts';

export type NumberGrouping = 'intl' | 'lakh';

const TRUE_MINUS = '\u2212';

/**
 * Parse a money field to integer paisa.
 * Accepts at most 2 decimal places. Empty or invalid input returns null.
 * A leading hyphen or true minus is kept only when `allowNegative` is set.
 */
export function parseMoneyToPaisa(
  raw: string,
  options?: { allowNegative?: boolean },
): number | null {
  const allowNegative = options?.allowNegative ?? false;
  let text = normaliseNumericText(raw).trim().toLowerCase();
  text = text.replaceAll(TRUE_MINUS, '-');
  text = text.replaceAll(',', '').replaceAll(' ', '');
  text = text.replaceAll('rs', '');
  if (text === '' || text === '-' || text === '.' || text === '-.') {
    return null;
  }
  const match = /^(-)?(\d*)(?:\.(\d{0,2}))?$/.exec(text);
  if (match === null) {
    return null;
  }
  const negative = match[1] === '-';
  if (negative && !allowNegative) {
    return null;
  }
  const wholeText = match[2] ?? '';
  const fraction = match[3] ?? '';
  if (wholeText === '' && fraction === '') {
    return null;
  }
  const whole = wholeText === '' ? 0 : Number(wholeText);
  const fractionPaisa =
    fraction.length === 0
      ? 0
      : fraction.length === 1
        ? Number(fraction) * 10
        : Number(fraction);
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fractionPaisa)) {
    return null;
  }
  const paisa = whole * 100 + fractionPaisa;
  if (!Number.isSafeInteger(paisa)) {
    return null;
  }
  return negative ? -paisa : paisa;
}

function groupIntl(rupees: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(
    rupees,
  );
}

/** Last three digits, then groups of two (1,24,500). */
export function groupLakh(rupees: number): string {
  const digits = String(rupees);
  if (digits.length <= 3) {
    return digits;
  }
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  const groupedHead = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${groupedHead},${tail}`;
}

/**
 * Format integer paisa.
 * Whole rupees omit decimals (`Rs 43,000`); otherwise two decimals (`Rs 3,459.77`).
 * Negatives use a true minus (`−Rs 500`).
 */
export function formatMoney(
  paisa: number,
  grouping: NumberGrouping = 'intl',
): string {
  if (!Number.isInteger(paisa)) {
    throw new Error('formatMoney expects integer paisa');
  }
  const negative = paisa < 0;
  const absolute = Math.abs(paisa);
  const rupees = Math.trunc(absolute / 100);
  const fraction = absolute % 100;
  const grouped = grouping === 'lakh' ? groupLakh(rupees) : groupIntl(rupees);
  const body =
    fraction === 0
      ? grouped
      : `${grouped}.${String(fraction).padStart(2, '0')}`;
  return negative ? `${TRUE_MINUS}Rs ${body}` : `Rs ${body}`;
}
