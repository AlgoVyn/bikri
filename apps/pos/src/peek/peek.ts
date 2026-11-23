import { BASE_PATH, isUlid } from '@bikri/core';

/** What a reference peek can show. The URL uses `<kind>:<ulid>`. */
export type PeekKind = 'product' | 'bill' | 'customer' | 'delivery';

export type PeekTarget = {
  kind: PeekKind;
  id: string;
};

export type PeekOriginSpec = {
  /** i18n key for the origin's short name, e.g. `peek.origin_bill`. */
  key: string;
  params?: Record<string, string>;
};

/** Stored on the peek's history entry so close/full can return to the exact origin. */
export type PeekOrigin = {
  href: string;
  labelKey: string;
  labelParams?: Record<string, string>;
  /** Back through history when the peek was opened from this app, replace when deep-linked. */
  mode: 'history' | 'replace';
};

const KINDS = new Set<PeekKind>(['product', 'bill', 'customer', 'delivery']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse `peek=product:<ulid>`; malformed values are ignored, never trusted. */
export function parsePeekTarget(value: unknown): PeekTarget | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 2) return null;
  const [kind, id] = parts;
  if (!KINDS.has(kind as PeekKind) || !id || !isUlid(id)) return null;
  return { kind: kind as PeekKind, id };
}

export function peekValue(target: PeekTarget): string {
  return `${target.kind}:${target.id}`;
}

/** Read the return context from history state. Unknown or external hrefs are dropped. */
export function parseOrigin(value: unknown): PeekOrigin | null {
  if (!isRecord(value)) return null;
  const { href, labelKey, labelParams, mode } = value;
  if (typeof href !== 'string' || !isInternalHref(href)) return null;
  if (typeof labelKey !== 'string' || !labelKey.startsWith('peek.'))
    return null;
  if (mode !== 'history' && mode !== 'replace') return null;
  if (labelParams !== undefined && !isRecord(labelParams)) return null;
  const params =
    labelParams === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(labelParams).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
  return { href, labelKey, labelParams: params, mode };
}

export function isInternalHref(href: string): boolean {
  if (href.startsWith('//')) return false;
  if (href === BASE_PATH || href.startsWith(`${BASE_PATH}/`)) return true;
  // TanStack's location.href is route-relative; either form is this app's own path.
  return href.startsWith('/');
}

/** Drop `peek` from a full internal href; the origin page is the same URL without it. */
export function stripPeekFromHref(href: string): string {
  if (typeof window === 'undefined') return href;
  try {
    const url = new URL(href, window.location.origin);
    url.searchParams.delete('peek');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}
