import { formatQtyFromMilli } from '@bikri/core';
import type { TFunction } from 'i18next';
import type { SaleMethod, SaleStatus } from '../data/salesHistory.ts';

export const METHOD_KEYS: Record<SaleMethod, string> = {
  cash: 'payment.cash',
  card: 'payment.card',
  bank_wallet: 'payment.bank_wallet',
  udhaar: 'payment.udhaar',
};

export const STATUS_KEYS: Record<SaleStatus, string> = {
  paid: 'office.sales.status_paid',
  part_refunded: 'office.sales.status_part_refunded',
  refunded: 'office.sales.status_refunded',
  void: 'office.sales.status_void',
};

export const STATUS_TONE: Record<SaleStatus, string> = {
  paid: 'bg-success-subtle text-success-subtle-ink',
  part_refunded: 'bg-warning-subtle text-warning-subtle-ink',
  refunded: 'bg-surface-2 text-text-muted',
  void: 'bg-danger-subtle text-danger-subtle-ink',
};

export const METHOD_TONE: Record<SaleMethod, string> = {
  cash: 'border-border-strong text-text',
  card: 'border-border-strong text-text',
  bank_wallet: 'border-border-strong text-text',
  udhaar: 'border-warning text-warning-subtle-ink',
};

export function localeOf(lang: string): string {
  return lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK';
}

export function timeText(at: number, lang: string, timeZone: string): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(at);
}

export function dateText(date: string, lang: string, timeZone: string): string {
  const at = Date.parse(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat(localeOf(lang), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(at);
}

/** "Today" / "Yesterday" for the day group headings, else the formatted date. */
export function dayHeading(
  t: TFunction,
  date: string,
  today: string,
  yesterday: string,
  lang: string,
  timeZone: string,
): string {
  if (date === today) return t('office.sales.today');
  if (date === yesterday) return t('office.sales.yesterday');
  return dateText(date, lang, timeZone);
}

export function qtyText(milli: number, unit = 'pc'): string {
  return formatQtyFromMilli(milli, unit);
}

export function methodLabel(t: TFunction, method: SaleMethod): string {
  return t(METHOD_KEYS[method]);
}

export function statusLabel(t: TFunction, status: string): string {
  const key = STATUS_KEYS[status as SaleStatus];
  return key ? t(key) : status;
}

export function statusTone(status: string): string {
  return STATUS_TONE[status as SaleStatus] ?? 'bg-surface-2 text-text-muted';
}

export const VOID_REASONS = [
  'wrong_item',
  'wrong_price',
  'customer_cancelled',
  'duplicate',
  'other',
] as const;

export const REFUND_REASONS = [
  'faulty',
  'changed_mind',
  'wrong_item',
  'exchange',
  'other',
] as const;

export type ReasonKey =
  | (typeof VOID_REASONS)[number]
  | (typeof REFUND_REASONS)[number];

export function reasonLabel(
  t: TFunction,
  key: ReasonKey,
  area: 'void' | 'refund',
): string {
  return t(`office.${area}.reason_${key}`);
}
