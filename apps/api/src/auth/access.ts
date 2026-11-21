/** Cloudflare Access JWT verification (01 §5, 05 §3.1). RS256 via WebCrypto, JWKS cached 1 h. */
import { fromBase64url } from './crypto.ts';

type Jwk = JsonWebKey & { kid?: string };
type Jwks = { keys: Jwk[] };
export type JwksFetcher = (url: string) => Promise<Jwks>;

const JWKS_TTL_MS = 3_600_000;
/**
 * A request carrying an Access JWT with an unknown `kid` may cause one refetch. Without a
 * floor, a forged `kid` loop turns every request into a live JWKS call (API-M6).
 */
const JWKS_MIN_REFETCH_MS = 60_000;
let cache: { url: string; at: number; keys: Map<string, CryptoKey> } | null =
  null;
let lastRefetchAt = 0;

const defaultFetcher: JwksFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  return (await res.json()) as Jwks;
};

async function loadKeys(
  url: string,
  fetcher: JwksFetcher,
): Promise<Map<string, CryptoKey>> {
  const jwks = await fetcher(url);
  if (!jwks || !Array.isArray(jwks.keys)) throw new Error('JWKS malformed');
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
  }
  cache = { url, at: Date.now(), keys };
  lastRefetchAt = Date.now();
  return keys;
}

export function resetJwksCache(): void {
  cache = null;
  lastRefetchAt = 0;
}

export type AccessClaims = {
  email: string;
  aud: string[];
  iss: string;
  exp: number;
};

type JwtHeader = { alg?: unknown; kid?: unknown };
type JwtClaims = {
  email?: unknown;
  aud?: unknown;
  iss?: unknown;
  exp?: unknown;
};

/** `JSON.parse` of a JWT segment must be a plain object; `null`/primitives are refused. */
function parseSegment(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

/** Returns the verified email, or null for any invalid token (wrong signature, aud, iss, exp). */
export async function verifyAccessJwt(
  token: string,
  opts: {
    teamDomain: string;
    aud: string;
    now?: number;
    fetcher?: JwksFetcher;
  },
): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = parseSegment(
    new TextDecoder().decode(fromBase64url(h)),
  ) as JwtHeader | null;
  const claims = parseSegment(
    new TextDecoder().decode(fromBase64url(p)),
  ) as JwtClaims | null;
  if (!header || !claims) return null;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  const domain = opts.teamDomain.replace(/^https?:\/\//, '');
  const url = `https://${domain}/cdn-cgi/access/certs`;
  const fetcher = opts.fetcher ?? defaultFetcher;
  let keys: Map<string, CryptoKey>;
  try {
    keys =
      cache && cache.url === url && Date.now() - cache.at < JWKS_TTL_MS
        ? cache.keys
        : await loadKeys(url, fetcher);
    // Key rotation: refetch once, but not more often than the floor (API-M6).
    if (
      !keys.has(header.kid) &&
      Date.now() - lastRefetchAt >= JWKS_MIN_REFETCH_MS
    )
      keys = await loadKeys(url, fetcher);
  } catch {
    // A JWKS outage is an authentication failure (401), never an unhandled 500.
    return null;
  }
  const key = keys.get(header.kid);
  if (!key) return null;
  let signature: Uint8Array;
  try {
    signature = fromBase64url(s);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;
  const now = opts.now ?? Date.now();
  const auds: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!opts.aud || !auds.includes(opts.aud)) return null;
  if (claims.iss !== `https://${domain}`) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  if (typeof claims.email !== 'string' || claims.email.length === 0)
    return null;
  return claims.email.toLowerCase();
}
