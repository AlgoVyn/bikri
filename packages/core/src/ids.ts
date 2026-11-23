import { monotonicFactory } from 'ulidx';

/**
 * ULIDs are identifiers, never secrets. `crypto.getRandomValues` is used everywhere it
 * exists (browsers, Workers); the fallback keeps test module evaluators working when a
 * coverage runtime has no Web Crypto installed.
 *
 * Exported for the unit test. A PRNG draw must stay inside [0, 1): `0xff / 0xff`
 * reached exactly 1 and only the base-32 encoder's clamp kept it valid, so divide by
 * `0x100` instead.
 */
export function randomUnit(): number {
  const source = globalThis.crypto;
  if (typeof source?.getRandomValues === 'function') {
    const byte = new Uint8Array(1);
    source.getRandomValues(byte);
    return (byte[0] ?? 0) / 0x100;
  }
  return Math.random();
}

let factory: ReturnType<typeof monotonicFactory> | null = null;

/** 26-char ULID made on the device (02 §1). Monotonic within one millisecond. */
export function newId(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 1 || now > 281_474_976_710_655)
    throw new RangeError('ULID time must be a positive 48-bit integer');
  // Lazy: module evaluators (V8 coverage, SSR) may not have `crypto` yet when the
  // module is first imported; the first real call always runs in the app/Worker.
  factory ??= monotonicFactory(randomUnit);
  return factory(now);
}

// The first character is the top bits of the 48-bit timestamp, so it cannot exceed `7`.
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: string): boolean {
  return ULID.test(value);
}
