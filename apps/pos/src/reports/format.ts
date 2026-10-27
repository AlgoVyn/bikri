import { formatQtyFromMilli } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import type { TFunction } from 'i18next';

export const DAY = 86_400_000;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / DAY) + 1;
}

export function qtyText(milli: number, unit = 'pc'): string {
  return formatQtyFromMilli(milli, unit);
}

export function percentText(bp: number): string {
  return `${(bp / 100).toFixed(1)}%`;
}

export function categoryName(category: MasterRow | null, lang: string): string {
  if (!category) return '';
  if (lang === 'ur' && String(category.name_ur ?? '').trim() !== '')
    return String(category.name_ur);
  return String(category.name_en);
}

export function groupName(
  row: { name: string; nameUr: string },
  lang: string,
): string {
  if (lang === 'ur' && row.nameUr.trim() !== '') return row.nameUr;
  return row.name;
}

export function shortDate(date: string, lang: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

export function longDate(date: string, lang: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

export function timeText(at: number, lang: string, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(at);
}

export function bucketLabel(t: TFunction, bucket: string): string {
  return t(
    `office.reports.bucket_${bucket.replaceAll('-', '_').replace('+', 'plus')}`,
  );
}
