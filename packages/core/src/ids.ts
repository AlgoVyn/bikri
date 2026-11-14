import { monotonicFactory } from 'ulidx';

const factory = monotonicFactory();

/** 26-char ULID made on the device (02 §1). Monotonic within one millisecond. */
export function newId(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 1 || now > 281_474_976_710_655)
    throw new RangeError('ULID time must be a positive 48-bit integer');
  return factory(now);
}

// The first character is the top bits of the 48-bit timestamp, so it cannot exceed `7`.
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: string): boolean {
  return ULID.test(value);
}
