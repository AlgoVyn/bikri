import type { TFunction } from 'i18next';
import type { StatementEntry } from '../data/udhaar.ts';
import { formatBusinessDate, formatTimestamp } from '../lib/date.ts';

const SHORT_DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** Compact `DD/MM/YY` date for the thermal statement; leaves room for description and amount. */
export function shortDateText(date: string, timeZone: string): string {
  let formatter = SHORT_DATE_FORMATS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      timeZone,
    });
    SHORT_DATE_FORMATS.set(timeZone, formatter);
  }
  return formatter.format(new Date(`${date}T12:00:00Z`));
}

export function dateText(date: string, lang: string, timeZone: string): string {
  return formatBusinessDate(date, lang, timeZone, 'date');
}

export function timeText(at: number, lang: string, timeZone: string): string {
  return formatTimestamp(at, lang, timeZone, 'datetimeShort');
}

export function balanceTone(balance: number): string {
  if (balance > 0) return 'text-text';
  if (balance < 0) return 'text-success-subtle-ink';
  return 'text-text-muted';
}

export function balanceLabel(
  t: TFunction,
  balance: number,
  money: (paisa: number) => string,
): string {
  if (balance > 0) return t('office.udhaar.owes', { amount: money(balance) });
  if (balance < 0)
    return t('office.udhaar.in_credit', {
      amount: money(-balance),
    });
  return t('office.udhaar.settled');
}

export function ageDays(at: number | null, now = Date.now()): number | null {
  if (at === null) return null;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}

export function ageDaysText(t: TFunction, days: number): string {
  if (days === 0) return t('office.udhaar.age_today');
  if (days === 1) return t('office.udhaar.age_one_day');
  return t('office.udhaar.days_old', { days });
}

export function ageLabel(
  t: TFunction,
  at: number | null,
  now = Date.now(),
): string {
  const days = ageDays(at, now);
  return days === null ? '' : ageDaysText(t, days);
}

export function limitPercent(
  balance: number,
  limit: number | null | undefined,
): number | null {
  if (limit === null || limit === undefined || limit <= 0) return null;
  return Math.min(100, Math.round((Math.max(0, balance) / limit) * 100));
}

/** The statement's description for the active language. */
export function entryDescription(t: TFunction, row: StatementEntry): string {
  if (row.kind === 'sale')
    return t('office.udhaar.entry_sale', {
      invoice: row.invoiceNo ?? '',
      count: row.lineCount,
    });
  if (row.kind === 'payment')
    return row.method
      ? t('office.udhaar.entry_payment', {
          method: t(`payment.${row.method}`),
        })
      : t('office.udhaar.entry_payment_plain');
  if (row.kind === 'refund')
    return t('office.udhaar.entry_refund', { invoice: row.invoiceNo ?? '' });
  if (row.kind === 'void')
    return t('office.udhaar.entry_void', { invoice: row.invoiceNo ?? '' });
  if (row.kind === 'opening') return t('office.udhaar.entry_opening');
  return row.note || t('office.udhaar.entry_adjustment');
}

/** Shorter description for the thermal statement; the PDF keeps the full wording. */
export function entryDescriptionShort(
  t: TFunction,
  row: StatementEntry,
): string {
  if (row.kind === 'sale')
    return t('office.udhaar.short_sale', {
      invoice: row.invoiceNo ?? '',
    });
  if (row.kind === 'payment')
    return row.method
      ? t('office.udhaar.short_payment', {
          method: t(`payment.${row.method}`),
        })
      : t('office.udhaar.short_payment_plain');
  if (row.kind === 'refund')
    return t('office.udhaar.short_refund', { invoice: row.invoiceNo ?? '' });
  if (row.kind === 'void')
    return t('office.udhaar.short_void', { invoice: row.invoiceNo ?? '' });
  if (row.kind === 'opening') return t('office.udhaar.short_opening');
  return row.note || t('office.udhaar.short_adjustment');
}

export function groupLabel(t: TFunction, key: string): string {
  if (key === 'promise') return t('office.udhaar.group_promise');
  if (key === '0-7') return t('office.udhaar.group_0_7');
  if (key === '8-30') return t('office.udhaar.group_8_30');
  if (key === '31-60') return t('office.udhaar.group_31_60');
  return t('office.udhaar.group_60');
}
