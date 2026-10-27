import { formatMoney, type NumberGrouping, parsePkPhone } from '@bikri/core';

const TRUE_MINUS = '\u2212';

/** `formatMoney`, with the true minus swapped for ASCII `-` (PC437 text mode). */
export function formatReceiptMoney(
  paisa: number,
  grouping: NumberGrouping = 'intl',
): string {
  return formatMoney(paisa, grouping).replaceAll(TRUE_MINUS, '-');
}

/** Grouped rupees without the `Rs ` prefix. Used on the 58 mm qty line. */
export function formatReceiptNumber(
  paisa: number,
  grouping: NumberGrouping,
): string {
  return formatReceiptMoney(Math.abs(paisa), grouping).replace(/^Rs /u, '');
}

/** Milli-units as a number, trailing zeros trimmed (`1`, `1.25`). */
export function formatItemCount(qtyMilli: number): string {
  if (!Number.isInteger(qtyMilli)) {
    throw new Error('quantity must be integer milli-units');
  }
  const negative = qtyMilli < 0;
  const absolute = Math.abs(qtyMilli);
  const whole = Math.trunc(absolute / 1000);
  const fraction = absolute % 1000;
  const body =
    fraction === 0
      ? String(whole)
      : `${whole}.${String(fraction).padStart(3, '0').replace(/0+$/u, '')}`;
  return negative ? `-${body}` : body;
}

/** Basis points to a percent string: 1700 → `17`, 1750 → `17.5`. */
export function formatTaxRate(bp: number): string {
  if (!Number.isInteger(bp)) {
    throw new Error('tax rate must be integer basis points');
  }
  const negative = bp < 0;
  const absolute = Math.abs(bp);
  const whole = Math.trunc(absolute / 100);
  const fraction = absolute % 100;
  const body =
    fraction === 0
      ? String(whole)
      : `${whole}.${String(fraction).padStart(2, '0').replace(/0+$/u, '')}`;
  return negative ? `-${body}` : body;
}

/** `DD-MM-YYYY HH:mm` in the shop time zone (default Asia/Karachi). */
export function formatReceiptDate(
  epochMs: number,
  timeZone = 'Asia/Karachi',
): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const hour = read('hour') === '24' ? '00' : read('hour');
  return `${read('day')}-${read('month')}-${read('year')} ${hour}:${read('minute')}`;
}

/** `YYYY-MM-DD` → `DD-MM-YYYY`. Anything else is returned unchanged. */
export function formatIsoDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (match === null) {
    return iso;
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/** Whole calendar days from `fromIso` to `untilIso`. Invalid dates return 0. */
export function calendarDaysBetween(fromIso: string, untilIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const until = Date.parse(`${untilIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(until)) {
    return 0;
  }
  return Math.round((until - from) / 86_400_000);
}

/** Pakistan display (`0300 1234567`). Unparseable input is returned trimmed. */
export function formatReceiptPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return parsePkPhone(trimmed, 'any')?.display ?? trimmed;
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{(\w+)\}/gu,
    (match, key: string) => vars[key] ?? match,
  );
}
