import { describe, expect, it } from 'vitest';
import { BASE_PATH } from './paths.ts';
import {
  ASSET_CACHE_CONTROL,
  IMMUTABLE_ASSET_PATHS,
  IMMUTABLE_CACHE_CONTROL,
  ROOT_REVALIDATE_CACHE_CONTROL,
  ROOT_REVALIDATE_PATHS,
  renderAssetHeaders,
  SECURITY_HEADERS,
  STABLE_ASSET_CACHE_CONTROL,
  STABLE_ASSET_PATHS,
  securityHeaderEntries,
} from './securityHeaders.ts';

const SPEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'sha256-nLz+WGEFrckBx6NbiOb1M+4DmyupJVxjEprI4MF42kI=' 'wasm-unsafe-eval'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' http://127.0.0.1:17890 http://localhost:17890; worker-src 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), usb=(self), serial=(self)',
} as const;

function parseBlocks(file: string): Record<string, Record<string, string>> {
  const blocks: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const line of file.split('\n')) {
    if (line.trim() === '') {
      current = null;
      continue;
    }
    if (!line.startsWith('  ')) {
      current = {};
      blocks[line] = current;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('  ! ')) {
      current[`! ${line.slice(4).trim()}`] = '';
      continue;
    }
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(2, separator).trim();
    const value = line.slice(separator + 2).trim();
    current[name] = value;
  }
  return blocks;
}

describe('security headers', () => {
  it('matches the architecture document exactly', () => {
    expect(SECURITY_HEADERS).toEqual(SPEC_HEADERS);
    expect(SECURITY_HEADERS['Strict-Transport-Security']).not.toContain(
      'includeSubDomains',
    );
  });

  it('keeps no-transform on HTML and caches hashed and stable assets correctly', () => {
    const file = renderAssetHeaders();
    expect(file.startsWith(`${BASE_PATH}\n`)).toBe(true);
    const blocks = parseBlocks(file);
    // `/bikri` itself and everything under `/bikri/*` both carry the security headers.
    for (const path of [BASE_PATH, `${BASE_PATH}/*`]) {
      expect(blocks[path]).toEqual({
        'Cache-Control': ASSET_CACHE_CONTROL,
        ...SECURITY_HEADERS,
      });
    }
    expect(ASSET_CACHE_CONTROL).toContain('no-transform');
    for (const path of IMMUTABLE_ASSET_PATHS) {
      expect(blocks[path]).toEqual({
        '! Cache-Control': '',
        'Cache-Control': IMMUTABLE_CACHE_CONTROL,
      });
      expect(IMMUTABLE_CACHE_CONTROL).not.toContain('no-transform');
    }
    // Icons and fonts keep stable filenames, so a year-long immutable cache would
    // strand a rebrand or font update in installed PWAs (review M2).
    for (const path of STABLE_ASSET_PATHS) {
      expect(blocks[path]).toEqual({
        '! Cache-Control': '',
        'Cache-Control': STABLE_ASSET_CACHE_CONTROL,
      });
      expect(STABLE_ASSET_CACHE_CONTROL).not.toContain('immutable');
      expect(IMMUTABLE_ASSET_PATHS).not.toContain(path);
    }
    // Root files revalidate but must be compressed: no-transform is HTML-only.
    for (const path of ROOT_REVALIDATE_PATHS) {
      expect(blocks[path]).toEqual({
        '! Cache-Control': '',
        'Cache-Control': ROOT_REVALIDATE_CACHE_CONTROL,
      });
      expect(ROOT_REVALIDATE_CACHE_CONTROL).not.toContain('no-transform');
    }
    expect(file).toContain(`${BASE_PATH}/workbox-*.js`);
    expect(Object.fromEntries(securityHeaderEntries())).toEqual(
      SECURITY_HEADERS,
    );
    expect(file).not.toContain('Access-Control-Allow-Origin');
  });
});
