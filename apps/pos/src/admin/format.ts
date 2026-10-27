import { BASE_PATH, businessDate } from '@bikri/core';

export const FREE_WRITES_PER_DAY = 100_000;
export const FREE_READS_PER_DAY = 5_000_000;
export const SHOP_SHARE = 0.7;
export const D1_LIMIT_BYTES = 500 * 1024 * 1024;
export const BACKUP_STALE_MS = 36 * 60 * 60 * 1000;
export const DEFAULT_WRITE_BUDGET = 7000;
export const OPS_CHUNK = 200;
export const EXPORT_PAGE = 1000;

const STATUSES = [
  'active',
  'read_only',
  'suspended',
  'maintenance',
  'deleting',
  'deleted',
] as const;

export type KnownStatus = (typeof STATUSES)[number];

export function statusLabelKey(status: string): string {
  switch (status) {
    case 'active':
      return 'admin.status_active';
    case 'read_only':
      return 'admin.status_read_only';
    case 'suspended':
      return 'admin.status_suspended';
    case 'maintenance':
      return 'admin.status_maintenance';
    case 'deleting':
      return 'admin.status_deleting';
    case 'deleted':
      return 'admin.status_deleted';
    default:
      return 'admin.status_unknown';
  }
}

export function knownStatuses(): readonly KnownStatus[] {
  return STATUSES;
}

export function localeOf(lang: string): string {
  return lang === 'ur' ? 'ur-PK' : 'en-GB';
}

export function formatCount(value: number, lang: string): string {
  return new Intl.NumberFormat(localeOf(lang), {
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatBytes(bytes: number, lang: string): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const text = new Intl.NumberFormat(localeOf(lang), {
    maximumFractionDigits: i === 0 ? 0 : 1,
  }).format(n);
  const unit = units[i] ?? 'B';
  return `${text} ${unit}`;
}

/** Date and time in Asia/Karachi. */
export function formatWhen(ms: number, lang: string): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    timeZone: 'Asia/Karachi',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

export function exportFilename(slug: string, at: number): string {
  return `bikri-export-${slug}-${businessDate(at)}.zip`;
}

/** Full href for an operator path. Lazy pages use anchors, not the router. */
export function adminHref(path: string): string {
  return `${BASE_PATH}${path}`;
}

/** Hue for the shop colour band, stable for a tenant id. */
export function tenantHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash, 31) + id.charCodeAt(i);
  }
  return Math.abs(hash) % 360;
}

export function tenantBandColor(id: string): string {
  return `hsl(${tenantHue(id)} 42% 28%)`;
}

export function barPercent(value: number, max: number): number {
  if (max <= 0) return value > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

export const SLUG_RE = /^[a-z0-9-]{3,30}$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function manifestKeyFor(sqlKey: string): string | null {
  if (!sqlKey.endsWith('.sql.gz')) return null;
  return `${sqlKey.slice(0, -'.sql.gz'.length)}.manifest.json`;
}

export function countdownParts(
  expiresAt: number,
  now: number,
): { hours: number; minutes: number; done: boolean } {
  const left = expiresAt - now;
  if (left <= 0) return { hours: 0, minutes: 0, done: true };
  return {
    hours: Math.floor(left / 3_600_000),
    minutes: Math.floor((left % 3_600_000) / 60_000),
    done: false,
  };
}
