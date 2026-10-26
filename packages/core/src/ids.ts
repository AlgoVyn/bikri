import { monotonicFactory } from 'ulidx';

const factory = monotonicFactory();

/** 26-char ULID made on the device (02 §1). Monotonic within one millisecond. */
export function newId(now: number = Date.now()): string {
  return factory(now);
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID.test(value);
}
