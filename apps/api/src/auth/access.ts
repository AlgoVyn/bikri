/** Cloudflare Access JWT verification (01 §5, 05 §3.1). RS256 via WebCrypto, JWKS cached 1 h. */
import { fromBase64url } from './crypto.ts';

type Jwk = JsonWebKey & { kid?: string };
type Jwks = { keys: Jwk[] };
export type JwksFetcher = (url: string) => Promise<Jwks>;

const JWKS_TTL_MS = 3_600_000;
let cache: { url: string; at: number; keys: Map<string, CryptoKey> } | null =
  null;

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
  return keys;
}

export function resetJwksCache(): void {
  cache = null;
}

export type AccessClaims = {
  email: string;
  aud: string[];
  iss: string;
  exp: number;
};

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
  let header: { alg?: string; kid?: string };
  let claims: { email?: unknown; aud?: unknown; iss?: unknown; exp?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64url(h)));
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(p)));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const domain = opts.teamDomain.replace(/^https?:\/\//, '');
  const url = `https://${domain}/cdn-cgi/access/certs`;
  const fetcher = opts.fetcher ?? defaultFetcher;
  let keys =
    cache && cache.url === url && Date.now() - cache.at < JWKS_TTL_MS
      ? cache.keys
      : await loadKeys(url, fetcher);
  if (!keys.has(header.kid)) keys = await loadKeys(url, fetcher); // key rotation: refetch once
  const key = keys.get(header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    fromBase64url(s),
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
