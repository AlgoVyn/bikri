import { formatMoney } from '@bikri/core';
import type { TFunction } from 'i18next';
import type { SupplierStatementEntry } from '../data/suppliers.ts';

export function supplierBalanceLabel(t: TFunction, balance: number): string {
  if (balance > 0)
    return t('office.suppliers.you_owe', { amount: formatMoney(balance) });
  if (balance < 0)
    return t('office.suppliers.advance', { amount: formatMoney(-balance) });
  return t('office.suppliers.settled');
}

export function supplierBalanceTone(balance: number): string {
  if (balance > 0) return 'text-danger';
  if (balance < 0) return 'text-success-subtle-ink';
  return 'text-text-muted';
}

export function supplierEntryDescription(
  t: TFunction,
  row: SupplierStatementEntry,
): string {
  if (row.kind === 'purchase')
    return t('office.suppliers.entry_delivery', {
      invoice: row.invoiceNo || '—',
      count: row.lineCount,
    });
  if (row.kind === 'payment')
    return t('office.suppliers.entry_paid', {
      method: row.method ? t(`payment.${row.method}`) : '',
    });
  if (row.kind === 'return')
    return t('office.suppliers.entry_return', {
      count: row.lineCount,
      reason: row.reason ?? '',
    });
  if (row.kind === 'refund')
    return t('office.suppliers.entry_refund', {
      method: row.method ? t(`payment.${row.method}`) : '',
    });
  if (row.kind === 'opening') return t('office.suppliers.entry_opening');
  return row.note || t('office.suppliers.entry_adjustment');
}

export function dateText(date: string, lang: string, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(new Date(`${date}T12:00:00Z`));
}
