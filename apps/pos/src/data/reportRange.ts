import { businessDate } from '@bikri/core';
import type { MasterRow, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import type { TableSource } from './caches.ts';
import type { ReportRange } from './reports.ts';

const DAY = 86_400_000;

/** Above two years, Reports and Sales warn before a long local scan (review M4). */
export const LONG_RANGE_DAYS = 730;

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** Ignore a placeholder `created_at` (0 or 1) in test fixtures and partial imports. */
const PLAUSIBLE_SHOP_MS = Date.UTC(2000, 0, 1);

function dateMs(date: string): number {
  if (!DATE.test(date)) return Number.NaN;
  const value = Date.parse(`${date}T00:00:00Z`);
  // Date.parse normalises 2026-02-31; reject a value that does not round-trip.
  return Number.isFinite(value) &&
    new Date(value).toISOString().slice(0, 10) === date
    ? value
    : Number.NaN;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Inclusive number of business days in a valid range; 0 when it is invalid. */
export function spanDays(from: string, to: string): number {
  const start = dateMs(from);
  const end = dateMs(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / DAY) + 1;
}

/**
 * The shop's first business day: the earliest of its creation date and the first row in
 * the dated tables. Imports and restores can carry rows older than the setup date, so the
 * creation date alone would cut real history off.
 *
 * The result changes only on an import/restore (normal sales are dated today or up to
 * 30 days back and cannot predate the shop), so a short in-memory cache avoids eight
 * index probes every time Reports or Sales opens.
 */
const FIRST_DAY_TTL_MS = 5 * 60_000;
let firstDayCacheEpoch = 0;
const firstDayCache = new WeakMap<
  object,
  { epoch: number; at: number; value: string | null }
>();

/** Test/restore hook: drop cached first-day values. */
export function clearFirstBusinessDayCache(): void {
  firstDayCacheEpoch += 1;
}

export async function firstBusinessDay(
  src: TableSource,
): Promise<string | null> {
  const cached = firstDayCache.get(src);
  if (
    cached !== undefined &&
    cached.epoch === firstDayCacheEpoch &&
    Date.now() - cached.at < FIRST_DAY_TTL_MS
  )
    return cached.value;
  const shop = await (src.table('shop') as Table<MasterRow, string>).get(
    'shop',
  );
  const timeZone = String(shop?.timezone ?? '') || 'Asia/Karachi';
  const created = Number(shop?.created_at ?? 0);
  const dates: string[] = [];
  if (Number.isFinite(created) && created > PLAUSIBLE_SHOP_MS)
    dates.push(businessDate(created, timeZone));
  const firsts = await Promise.all(
    (
      [
        'sales',
        'payments',
        'refunds',
        'expenses',
        'day_closes',
        'stock_movements',
        'purchases',
        'supplier_returns',
      ] as const
    ).map((name) =>
      (src.table(name) as Table<SyncedRow, string>)
        .orderBy('business_date')
        .first(),
    ),
  );
  for (const row of firsts) {
    const date = String(row?.business_date ?? '');
    if (DATE.test(date) && Number.isFinite(dateMs(date))) dates.push(date);
  }
  dates.sort();
  const value = dates[0] ?? null;
  firstDayCache.set(src, {
    epoch: firstDayCacheEpoch,
    at: Date.now(),
    value,
  });
  return value;
}

/** Inclusive calendar-month chunks covering a range; [] for an invalid range. */
export function monthChunks(
  from: string,
  to: string,
): { from: string; to: string }[] {
  const start = dateMs(from);
  const end = dateMs(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [];
  const chunks: { from: string; to: string }[] = [];
  let cursor = start;
  while (cursor <= end) {
    const date = new Date(cursor);
    const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
    const chunkEnd = Math.min(monthEnd, end);
    chunks.push({ from: isoDay(cursor), to: isoDay(chunkEnd) });
    cursor = chunkEnd + DAY;
  }
  return chunks;
}

export type ClampedRange = {
  range: ReportRange;
  /** The requested days before clamping. */
  requestedDays: number;
  /** The days actually computed. */
  days: number;
  /** `from` or `to` moved to the shop's history or today. */
  clamped: boolean;
  /** The requested or effective range is above two years. */
  long: boolean;
};

/**
 * Bound a report range to real shop data. A mistyped year (0202 or 9999) otherwise
 * builds hundreds of thousands of day buckets and can freeze a low-end till.
 */
export function clampReportRange(
  range: ReportRange,
  first: string | null,
  today: string,
): ClampedRange {
  const todayMs = dateMs(today) || Date.now();
  const requestedDays = spanDays(range.from, range.to);
  let from = dateMs(range.from);
  let to = dateMs(range.to);
  if (!Number.isFinite(from)) from = todayMs;
  if (!Number.isFinite(to)) to = todayMs;
  if (to > todayMs) to = todayMs;
  if (from > to) from = to;
  const firstMs = first === null ? Number.NaN : dateMs(first);
  if (Number.isFinite(firstMs)) {
    // A range entirely before the shop's first day stays empty (and small): keep its
    // last day, so a mistyped 0202–2020 cannot build 700k empty buckets either.
    if (to < firstMs) from = to;
    else if (from < firstMs) from = firstMs;
  }
  if (from > to) from = to;
  const clampedFrom = isoDay(from);
  const clampedTo = isoDay(to);
  const days = Math.floor((to - from) / DAY) + 1;
  return {
    range: { ...range, from: clampedFrom, to: clampedTo },
    requestedDays,
    days,
    clamped: clampedFrom !== range.from || clampedTo !== range.to,
    long: Math.max(requestedDays, days) > LONG_RANGE_DAYS,
  };
}
