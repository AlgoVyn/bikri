/** Staff PINs (05 §4): PBKDF2-SHA256, 150,000 iterations, 16-byte salt, 32-byte hash, base64. */
export const PIN_ITERATIONS = 150_000;

export type PinHash = {
  pin_hash: string;
  pin_salt: string;
  pin_iterations: number;
};

const WEAK = new Set(['1234', '4321', '1212']);

/**
 * Weak PINs rejected at creation (05 §4): repeated digits, 1234, 4321, 1212 and 19xx / 20xx
 * years. A PIN already used by another active staff member is checked separately against the
 * stored verifiers (`isPinTaken` in the till): each row has its own salt, so a plain list of
 * PINs cannot answer it.
 */
export function isWeakPin(pin: string): boolean {
  if (!/^\d{4,6}$/.test(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;
  if (WEAK.has(pin)) return true;
  if (pin.length === 4 && /^(19|20)\d\d$/.test(pin)) return true;
  return false;
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function derive(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Hashes a PIN in the browser with WebCrypto. Never call inside a Dexie transaction. */
export async function hashPin(
  pin: string,
  iterations: number = PIN_ITERATIONS,
  salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16)),
): Promise<PinHash> {
  if (!Number.isSafeInteger(iterations) || iterations < 1_000)
    throw new RangeError('invalid PBKDF2 iteration count');
  const hash = await derive(pin, salt, iterations);
  return {
    pin_hash: toBase64(hash),
    pin_salt: toBase64(salt),
    pin_iterations: iterations,
  };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** Shape every stored verifier must have, regardless of its iteration count. */
function verifierShape(stored: {
  pin_hash?: unknown;
  pin_salt?: unknown;
  pin_iterations?: unknown;
}): boolean {
  const { pin_hash: hash, pin_salt: salt, pin_iterations: iterations } = stored;
  return (
    typeof hash === 'string' &&
    hash.length >= 16 &&
    hash.length <= 200 &&
    BASE64.test(hash) &&
    typeof salt === 'string' &&
    salt.length >= 16 &&
    salt.length <= 200 &&
    BASE64.test(salt) &&
    Number.isSafeInteger(iterations) &&
    Number(iterations) >= 1 &&
    Number(iterations) <= 10_000_000
  );
}

/**
 * A stored verifier the app should write: 16-byte salt and 32-byte hash in base64 and the
 * documented PBKDF2 iteration range. A malformed row (a hand-edited restore, an old buggy
 * build) must not make PIN unlock throw on every till of the shop (05 §4). Test fixtures may
 * use a lower iteration count, so `verifyPin` accepts those; this stricter check guards new
 * writes on the server and the operator import.
 */
export function isPinVerifierValid(stored: {
  pin_hash?: unknown;
  pin_salt?: unknown;
  pin_iterations?: unknown;
}): boolean {
  return (
    verifierShape(stored) &&
    Number(stored.pin_iterations) >= 100_000 &&
    Number(stored.pin_iterations) <= 1_000_000
  );
}

/** Never throws on a malformed verifier: a bad row is a wrong PIN, not a broken lock screen. */
export async function verifyPin(
  pin: string,
  stored: PinHash,
): Promise<boolean> {
  if (!verifierShape(stored)) return false;
  try {
    const hash = await derive(
      pin,
      fromBase64(stored.pin_salt),
      stored.pin_iterations,
    );
    const expected = fromBase64(stored.pin_hash);
    if (hash.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < hash.length; i += 1)
      diff |= (hash[i] ?? 0) ^ (expected[i] ?? 0);
    return diff === 0;
  } catch {
    return false;
  }
}
