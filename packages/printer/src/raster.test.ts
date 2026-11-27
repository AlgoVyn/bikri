import { describe, expect, it } from 'vitest';
import {
  encodeGsV0,
  logoGsV0,
  packMono,
  prepareLogo,
  scaleToFit,
} from './raster.ts';
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

  it('packs opaque grayscale RGBA exactly like blended luma', () => {
    // The Urdu canvas renderer returns opaque black/white/grey, the fast path.
    const width = 13;
    const height = 3;
    const rgba = new Uint8Array(width * height * 4);
    const graySource = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
      const black = (i * 7 + Math.floor(i / width)) % 3 === 0;
      const value = black ? 0 : 255;
      graySource[i] = value;
      rgba[i * 4] = value;
      rgba[i * 4 + 1] = value;
      rgba[i * 4 + 2] = value;
      rgba[i * 4 + 3] = 255;
    }
    const fromRgba = packMono(
      { width, height, data: rgba, format: 'rgba' },
      'threshold',
    );
    const fromGray = packMono(
      { width, height, data: graySource, format: 'gray' },
      'threshold',
    );
    expect([...fromRgba.data]).toEqual([...fromGray.data]);
    expect(fromRgba.widthBytes).toBe(2);

    // Mid-greys (antialiased glyph edges) use the same operand order as
    // blendedLuma; 128 evaluates to 127.999… and must stay black.
    const shades = new Uint8Array([0, 64, 127, 128, 200, 255]);
    const shadeRgba = new Uint8Array(shades.length * 4);
    for (let i = 0; i < shades.length; i += 1) {
      const value = shades[i] ?? 0;
      shadeRgba.set([value, value, value, 255], i * 4);
    }
    const packed = packMono(
      { width: shades.length, height: 1, data: shadeRgba, format: 'rgba' },
      'threshold',
    );
    const expected = shades.map((value) =>
      0.299 * value + 0.587 * value + 0.114 * value < 128 ? 1 : 0,
    );
    const bits: number[] = [];
    for (let x = 0; x < shades.length; x += 1) {
      bits.push(((packed.data[0] ?? 0) >> (7 - x)) & 1);
    }
    expect(bits).toEqual([...expected]);
  });

  it('packs opaque black/white Gray directly and falls back for other greys', () => {
    const mono = gray(10, 1, (x) => (x % 2 === 0 ? 0 : 255));
    expect([...packMono(mono, 'threshold').data]).toEqual([0xaa, 0x80]);
    // 127 is black at the 50% threshold even though it is not pure white.
    const grey = gray(10, 1, (x) => (x < 5 ? 127 : 128));
    expect([...packMono(grey, 'threshold').data]).toEqual([0xf8, 0x00]);
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

  it('rejects a NaN target and a truncated same-size gray buffer', () => {
    expect(() =>
      scaleToFit(
        gray(4, 4, () => 0),
        Number.NaN,
        10,
      ),
    ).toThrow();
    expect(() =>
      scaleToFit(
        gray(4, 4, () => 0),
        Number.POSITIVE_INFINITY,
        10,
      ),
    ).toThrow();
    // The same-size fast path used to return the short buffer as-is.
    expect(() =>
      scaleToFit(
        { width: 4, height: 4, data: new Uint8Array(4), format: 'gray' },
        10,
        10,
      ),
    ).toThrow();
  });
});

describe('logo GS v 0 cache (M17.2)', () => {
  const logo = (offset: number): RasterSource => {
    const width = 40;
    const height = 12;
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = (i + offset) % 3 === 0 ? 0 : 255;
    }
    return { width, height, data, format: 'gray' };
  };

  it('returns the exact bytes of the uncached encoder', () => {
    const source = logo(0);
    const expected = encodeGsV0(packMono(prepareLogo(source, 384), 'dither'));
    expect([...logoGsV0(source, 384)]).toEqual([...expected]);
  });

  it('reuses the packed bytes for the same pixels from a fresh buffer and dots', () => {
    const first = logoGsV0(logo(0), 384);
    // IndexedDB returns a fresh Uint8Array on every kv read; the pixel hash,
    // not object identity, must find the cached bytes.
    const second = logoGsV0(logo(0), 384);
    expect(second).toBe(first);
    const otherDots = logoGsV0(logo(0), 576);
    expect(otherDots).not.toBe(first);
  });

  it('does not reuse bytes for different pixels and bounds the cache', () => {
    const a = logoGsV0(logo(0), 384);
    const b = logoGsV0(logo(1), 384);
    expect([...b]).not.toEqual([...a]);
    // More distinct logos than the cache holds must not grow it without bound;
    // the oldest entries are simply re-encoded.
    for (let i = 2; i < 20; i += 1) {
      logoGsV0(logo(i), 384);
    }
    expect([...logoGsV0(logo(0), 384)]).toEqual([...a]);
  });

  it('rejects a target narrower than 8 dots', () => {
    expect(() => logoGsV0(logo(0), 7)).toThrow();
  });
});
