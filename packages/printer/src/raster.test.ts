import { describe, expect, it } from 'vitest';
import { encodeGsV0, packMono, prepareLogo, scaleToFit } from './raster.ts';
import type { RasterSource } from './types.ts';

// 06 §10 raster.test.ts: 1-bit packing of a known 16×2 bitmap; band splitting at 255 rows.

function gray(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): RasterSource {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = pixel(x, y);
  }
  return { width, height, data, format: 'gray' };
}

describe('packMono', () => {
  it('packs a known 16×2 bitmap MSB-first, 1 = black', () => {
    // Row 0: black at x = 0 and 15; row 1: black at x = 0..7.
    const src = gray(16, 2, (x, y) =>
      (y === 0 && (x === 0 || x === 15)) || (y === 1 && x < 8) ? 0 : 255,
    );
    const packed = packMono(src, 'threshold');
    expect(packed.widthBytes).toBe(2);
    expect([...packed.data]).toEqual([0x80, 0x01, 0xff, 0x00]);
  });

  it('thresholds at 50% luminance and pads the last byte with white', () => {
    const src = gray(10, 1, (x) => (x < 5 ? 127 : 128));
    expect([...packMono(src, 'threshold').data]).toEqual([0xf8, 0x00]);
  });

  it('reads RGBA with alpha over white', () => {
    const data = Uint8Array.from([
      0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255,
    ]);
    const packed = packMono(
      { width: 4, height: 1, data, format: 'rgba' },
      'threshold',
    );
    expect([...packed.data]).toEqual([0x90]);
  });

  it('dithers a 50% grey to about half black (Floyd–Steinberg)', () => {
    const src = gray(64, 64, () => 128);
    const packed = packMono(src, 'dither');
    let black = 0;
    for (const byte of packed.data)
      for (let b = 0; b < 8; b += 1) black += (byte >> b) & 1;
    expect(black / (64 * 64)).toBeGreaterThan(0.4);
    expect(black / (64 * 64)).toBeLessThan(0.6);
  });
});

describe('encodeGsV0', () => {
  it('writes the header with width in bytes and height in rows', () => {
    const bytes = encodeGsV0({
      widthBytes: 2,
      height: 1,
      data: Uint8Array.from([0xaa, 0x55]),
    });
    expect([...bytes]).toEqual([
      0x1d, 0x76, 0x30, 0x00, 2, 0, 1, 0, 0xaa, 0x55,
    ]);
  });

  it('splits into bands of at most 255 rows', () => {
    const height = 600;
    const bytes = encodeGsV0({
      widthBytes: 1,
      height,
      data: new Uint8Array(height),
    });
    const headers: number[] = [];
    let i = 0;
    while (i < bytes.length) {
      expect([...bytes.subarray(i, i + 4)]).toEqual([0x1d, 0x76, 0x30, 0x00]);
      const rows = (bytes[i + 6] ?? 0) + 256 * (bytes[i + 7] ?? 0);
      headers.push(rows);
      i += 8 + rows;
    }
    expect(headers).toEqual([255, 255, 90]);
  });

  it('rejects short data', () => {
    expect(() =>
      encodeGsV0({ widthBytes: 2, height: 2, data: new Uint8Array(3) }),
    ).toThrow();
  });
});

describe('logo preparation (06 §6)', () => {
  it('scales to at most 60% of dots and 160 px tall, centred on the paper width', () => {
    const logo = prepareLogo(
      gray(1000, 1000, () => 0),
      576,
    );
    expect(logo.width).toBe(576);
    expect(logo.height).toBe(160);
    const wide = prepareLogo(
      gray(2000, 100, () => 0),
      384,
    );
    expect(wide.width).toBe(384);
    // 60% of 384 = 230 px of logo → about 77 white columns each side.
    const row = [...wide.data.subarray(0, 384)];
    const firstBlack = row.indexOf(0);
    const lastBlack = row.lastIndexOf(0);
    expect(lastBlack - firstBlack + 1).toBeLessThanOrEqual(230);
    expect(Math.abs(firstBlack - (383 - lastBlack))).toBeLessThanOrEqual(1);
  });

  it('never upscales', () => {
    const small = scaleToFit(
      gray(10, 5, () => 0),
      300,
      160,
    );
    expect([small.width, small.height]).toEqual([10, 5]);
  });
});
