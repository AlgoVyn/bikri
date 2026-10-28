import { BASE_PATH } from './paths.ts';

/**
 * Security headers from docs/01-architecture.md §5.2.
 * The asset `_headers` file and the Hono middleware both read this map.
 */
export const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(self), usb=(self), serial=(self), bluetooth=()',
} as const;

export type SecurityHeaderName = keyof typeof SECURITY_HEADERS;

/**
 * Cloudflare Web Analytics injects a beacon into HTML unless the response says
 * `no-transform`; Bikri must not load third-party scripts (AGENTS.md, D-131).
 * HTML still revalidates on every load, and Workbox precaches the assets.
 */
export const ASSET_CACHE_CONTROL =
  'public, max-age=0, must-revalidate, no-transform';

export function securityHeaderEntries(): ReadonlyArray<
  readonly [SecurityHeaderName, string]
> {
  return Object.entries(SECURITY_HEADERS) as ReadonlyArray<
    readonly [SecurityHeaderName, string]
  >;
}

/** Cloudflare Workers `_headers` body. Rules apply to `${BASE_PATH}/*`. */
export function renderAssetHeaders(): string {
  const lines = [`${BASE_PATH}/*`, `  Cache-Control: ${ASSET_CACHE_CONTROL}`];
  for (const [name, value] of securityHeaderEntries()) {
    lines.push(`  ${name}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}
