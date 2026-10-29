import { formatMoney } from '@bikri/core';
import type { TFunction } from 'i18next';
import type { StatementEntry } from '../data/udhaar.ts';

export function localeOf(lang: string): string {
  return lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK';
}

export function dateText(date: string, lang: string, timeZone: string): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(new Date(`${date}T12:00:00Z`));
}

export function timeText(at: number, lang: string, timeZone: string): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(at);
}

export function balanceTone(balance: number): string {
  if (balance > 0) return 'text-text';
  if (balance < 0) return 'text-success-subtle-ink';
  return 'text-text-muted';
}

export function balanceLabel(t: TFunction, balance: number): string {
  if (balance > 0)
    return t('office.udhaar.owes', { amount: formatMoney(balance) });
  if (balance < 0)
    return t('office.udhaar.in_credit', {
      amount: formatMoney(-balance),
    });
  return t('office.udhaar.settled');
}

export function ageDays(at: number | null, now = Date.now()): number | null {
  if (at === null) return null;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}

export function ageLabel(
  t: TFunction,
  at: number | null,
  now = Date.now(),
): string {
  const days = ageDays(at, now);
  if (days === null) return '';
  return t('office.udhaar.days_old', { days });
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
    return t('office.udhaar.entry_payment', {
      method: row.method ? t(`payment.${row.method}`) : '',
    });
  if (row.kind === 'refund')
    return t('office.udhaar.entry_refund', { invoice: row.invoiceNo ?? '' });
  if (row.kind === 'void')
    return t('office.udhaar.entry_void', { invoice: row.invoiceNo ?? '' });
  if (row.kind === 'opening') return t('office.udhaar.entry_opening');
  return row.note || t('office.udhaar.entry_adjustment');
}

export function groupLabel(t: TFunction, key: string): string {
  if (key === 'promise') return t('office.udhaar.group_promise');
  if (key === '0-7') return t('office.udhaar.group_0_7');
  if (key === '8-30') return t('office.udhaar.group_8_30');
  if (key === '31-60') return t('office.udhaar.group_31_60');
  return t('office.udhaar.group_60');
}
