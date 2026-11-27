import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUlid, newId, randomUnit } from './ids.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ids', () => {
  it('makes monotonic ULIDs for one timestamp', () => {
    const at = 1_793_050_000_000;
    const a = newId(at);
    const b = newId(at);
    expect(isUlid(a)).toBe(true);
    expect(isUlid(b)).toBe(true);
    expect(b > a).toBe(true);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });

  it('rejects a timestamp that is not a 48-bit non-negative integer', () => {
    for (const value of [
      0,
      -1,
      1.5,
      281_474_976_710_656,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => newId(value), String(value)).toThrow(RangeError);
    }
    expect(isUlid(newId(1))).toBe(true);
  });

  it('accepts only the ULID alphabet and a first character from 0 to 7', () => {
    expect(isUlid('01JB0000000000000000000001')).toBe(true);
    expect(isUlid('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(true);
    expect(isUlid('ZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
    expect(isUlid('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
    expect(isUlid('01jb0000000000000000000001')).toBe(false);
    expect(isUlid('01JB000000000000000000000I')).toBe(false);
    expect(isUlid('')).toBe(false);
  });

  it('draws base-32 digits from a uniform [0, 1) range', () => {
    const draw = (value: number) => {
      vi.stubGlobal('crypto', {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(value);
          return bytes;
        },
      });
      return randomUnit();
    };
    expect(draw(0)).toBe(0);
    expect(draw(0x80)).toBe(0.5);
    expect(draw(0xff)).toBe(0xff / 0x100);
    expect(draw(0xff)).toBeLessThan(1);
  });
});
