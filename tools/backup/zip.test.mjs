import { describe, expect, it } from 'vitest';
import { zipStore } from './zip.mjs';

function dosDate(bytes) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(12, true);
}

describe('STORE-only ZIP writer', () => {
  it('writes a readable local header and central directory', () => {
    const bytes = zipStore(
      [{ name: 'manifest.json', data: new TextEncoder().encode('{}') }],
      Date.UTC(2026, 10, 22, 5, 5, 5),
    );
    expect(bytes.subarray(0, 4)).toEqual(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(new TextDecoder().decode(bytes)).toContain('manifest.json');
    const date = dosDate(bytes);
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 0xf).toBe(11);
    expect(date & 0x1f).toBe(22);
  });

  it('clamps years a DOS date cannot represent', () => {
    const bytes = zipStore([{ name: 'a', data: new Uint8Array() }], 0);
    expect((dosDate(bytes) >> 9) + 1980).toBe(1980);
  });

  it('refuses more entries than ZIP32 can address', () => {
    const files = Array.from({ length: 65_536 }, () => ({
      name: 'x',
      data: new Uint8Array(),
    }));
    expect(() => zipStore(files)).toThrow(/65,535 entries/u);
  });
});
