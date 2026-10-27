/** Staff PINs (05 §4): PBKDF2-SHA256, 150,000 iterations, 16-byte salt, 32-byte hash, base64. */
export const PIN_ITERATIONS = 150_000;

export type PinHash = {
  pin_hash: string;
  pin_salt: string;
  pin_iterations: number;
};

const WEAK = new Set(['1234', '4321', '1212']);

/**
 * Weak PINs rejected at creation (05 §4): repeated digits, 1234, 4321, 1212, 19xx / 20xx
 * years, and any PIN already used by another active staff member of this shop.
 */
export function isWeakPin(
  pin: string,
  takenPins: readonly string[] = [],
): boolean {
  if (!/^\d{4,6}$/.test(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;
  if (WEAK.has(pin)) return true;
  if (pin.length === 4 && /^(19|20)\d\d$/.test(pin)) return true;
  return takenPins.includes(pin);
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
  const hash = await derive(pin, salt, iterations);
  return {
    pin_hash: toBase64(hash),
    pin_salt: toBase64(salt),
    pin_iterations: iterations,
  };
}

export async function verifyPin(
  pin: string,
  stored: PinHash,
): Promise<boolean> {
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
}
