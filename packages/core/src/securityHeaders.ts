import { BASE_PATH } from './paths.ts';

/**
 * Security headers from docs/01-architecture.md §5.2.
 * The asset `_headers` file and the Hono middleware both read this map.
 */
export const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'sha256-nLz+WGEFrckBx6NbiOb1M+4DmyupJVxjEprI4MF42kI=' 'wasm-unsafe-eval'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' http://127.0.0.1:17890 http://localhost:17890; worker-src 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), usb=(self), serial=(self)',
} as const;

export type SecurityHeaderName = keyof typeof SECURITY_HEADERS;

/**
 * Cloudflare Web Analytics injects a beacon into HTML unless the response says
 * `no-transform`; Bikri must not load third-party scripts (AGENTS.md, D-131).
 * `no-transform` must stay on HTML only: Cloudflare also disables Brotli/Gzip for
 * any response carrying it, which tripled the JS/CSS payload before D-231.
 */
export const ASSET_CACHE_CONTROL =
  'public, max-age=0, must-revalidate, no-transform';

/** Content-hashed files can never change under the same URL (D-231). */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Directories/files whose filenames carry a content hash. */
export const IMMUTABLE_ASSET_PATHS = [
  `${BASE_PATH}/assets/*`,
  `${BASE_PATH}/workbox-*.js`,
] as const;

/**
 * Icons and fonts keep stable filenames because the web manifest, index.html and
 * installed PWAs refer to them, so they cannot be immutable for a year. A day of
 * caching keeps repeat loads cheap and lets a rebrand or font update land.
 */
export const STABLE_ASSET_CACHE_CONTROL =
  'public, max-age=86400, must-revalidate';

/** Unhashed assets that keep a stable filename across releases. */
export const STABLE_ASSET_PATHS = [
  `${BASE_PATH}/fonts/*`,
  `${BASE_PATH}/icons/*`,
  `${BASE_PATH}/brand/*`,
] as const;

/**
 * Root files that must revalidate on every load but must not inherit the broad
 * `no-transform`: Cloudflare disables Brotli/Gzip for `no-transform` responses,
 * and the service worker, manifest and pre-paint theme script are tiny but hot.
 */
export const ROOT_REVALIDATE_CACHE_CONTROL =
  'public, max-age=0, must-revalidate';
export const ROOT_REVALIDATE_PATHS = [
  `${BASE_PATH}/sw.js`,
  `${BASE_PATH}/manifest.webmanifest`,
] as const;

export function securityHeaderEntries(): ReadonlyArray<
  readonly [SecurityHeaderName, string]
> {
  return Object.entries(SECURITY_HEADERS) as ReadonlyArray<
    readonly [SecurityHeaderName, string]
  >;
}

/**
 * Cloudflare Workers `_headers` body. Rules apply in file order and a repeated
 * header is joined, so the broad rule sets the security headers and the narrow
 * rules detach and replace Cache-Control (Workers static-assets "Detach a
 * header"). HTML keeps `no-transform`; hashed assets and the Workbox runtime
 * become immutable, stable filenames revalidate daily, and the root service
 * worker, manifest and theme script revalidate without `no-transform`.
 */
export function renderAssetHeaders(): string {
  const blocks: string[] = [];
  const broad = [`${BASE_PATH}/*`, `  Cache-Control: ${ASSET_CACHE_CONTROL}`];
  for (const [name, value] of securityHeaderEntries()) {
    broad.push(`  ${name}: ${value}`);
  }
  blocks.push(broad.join('\n'));
  for (const path of IMMUTABLE_ASSET_PATHS) {
    blocks.push(
      [
        path,
        '  ! Cache-Control',
        `  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`,
      ].join('\n'),
    );
  }
  for (const path of STABLE_ASSET_PATHS) {
    blocks.push(
      [
        path,
        '  ! Cache-Control',
        `  Cache-Control: ${STABLE_ASSET_CACHE_CONTROL}`,
      ].join('\n'),
    );
  }
  for (const path of ROOT_REVALIDATE_PATHS) {
    blocks.push(
      [
        path,
        '  ! Cache-Control',
        `  Cache-Control: ${ROOT_REVALIDATE_CACHE_CONTROL}`,
      ].join('\n'),
    );
  }
  return `${blocks.join('\n\n')}\n`;
}
