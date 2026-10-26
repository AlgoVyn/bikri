import { describe, expect, it } from 'vitest';
import { BASE_PATH } from './paths.ts';
import {
  renderAssetHeaders,
  SECURITY_HEADERS,
  securityHeaderEntries,
} from './securityHeaders.ts';

const SPEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(self), usb=(self), serial=(self), bluetooth=()',
} as const;

function parseAssetHeaders(file: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of file.split('\n')) {
    if (!line.startsWith('  ')) {
      continue;
    }
    const separator = line.indexOf(':');
    const name = line.slice(2, separator);
    const value = line.slice(separator + 2);
    parsed[name] = value;
  }
  return parsed;
}

describe('security headers', () => {
  it('matches the architecture document exactly', () => {
    expect(SECURITY_HEADERS).toEqual(SPEC_HEADERS);
    expect(SECURITY_HEADERS['Strict-Transport-Security']).not.toContain(
      'includeSubDomains',
    );
  });

  it('writes an asset _headers file with the same pairs the middleware sets', () => {
    const file = renderAssetHeaders();
    expect(file.startsWith(`${BASE_PATH}/*\n`)).toBe(true);
    expect(parseAssetHeaders(file)).toEqual(SECURITY_HEADERS);
    expect(Object.fromEntries(securityHeaderEntries())).toEqual(
      SECURITY_HEADERS,
    );
    expect(file).not.toContain('Access-Control-Allow-Origin');
  });
});
