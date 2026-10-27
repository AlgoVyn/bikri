/** Tokens, codes and hashes (05 §2, 04 §3.8). WebCrypto only: no CPU-heavy work in the Worker. */

const encoder = new TextEncoder();

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** A device token: 32 random bytes as 43 base64url characters (04 §2). */
export function newDeviceToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Enrolment code alphabet: no 0 O 1 I L U (04 §3.8, screens/02). */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `n` symbols from `alphabet` with rejection sampling (no modulo bias). */
export function randomSymbols(n: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < limit && out.length < n) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

/** 8-symbol enrolment code, shown as `XXXX-XXXX`. */
export function newEnrolmentCode(): string {
  const raw = randomSymbols(8, CODE_ALPHABET);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Upper-case, no dash: the form that is hashed. Null when it cannot be a code. */
export function normaliseCode(code: string): string | null {
  const c = code.trim().toUpperCase().replace('-', '');
  return /^[2-9A-HJKMNP-TV-Z]{8}$/u.test(c) ? c : null;
}

export function codeHash(normalised: string): Promise<string> {
  return sha256Hex(`enrol:${normalised}`);
}

/** Six digits with rejection sampling (owner email sign-in, 05 §3.2). */
export function newSixDigitCode(): string {
  return randomSymbols(6, '0123456789');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function hmacHex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await hmacKey(secret);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Constant-time comparison of two equal-length strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `base64url(payload).base64url(hmac)`; verify returns the payload or null. */
export async function signToken(
  secret: string,
  payload: unknown,
): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(body)),
  );
  return `${body}.${base64url(sig)}`;
}

export async function verifyToken<T>(
  secret: string,
  token: string,
): Promise<T | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig || token.split('.').length !== 2) return null;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64url(sig),
      encoder.encode(body),
    );
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T;
  } catch {
    return null;
  }
}
