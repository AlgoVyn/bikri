import { describe, expect, it } from 'vitest';
import { encodeEscPos } from './escpos.ts';
import { createFakeRasterRenderer } from './fakeRaster.ts';
import { columnWidths, formatPair, layOut, resolvePaper } from './layout.ts';
import {
  centerOnWidth,
  encodeGsV0,
  fitRasterToDots,
  packMono,
  prepareLogo,
  scaleToFit,
} from './raster.ts';
import type { Block, RasterSource } from './types.ts';

// Defensive paths: bad options must fail loudly, never print garbage.

const opts = { charsPerLine: 48, dots: 576 };
const gray = (w: number, h: number, v = 0): RasterSource => ({
  width: w,
  height: h,
  data: new Uint8Array(w * h).fill(v),
  format: 'gray',
});

describe('encoder guards', () => {
  it('rejects bad dots, drawer pins and QR data', () => {
    expect(() => encodeEscPos([], { ...opts, dots: 0 })).toThrow(/dots/);
    expect(() => encodeEscPos([], { ...opts, drawerPin: 3 as 2 })).toThrow(
      /drawer pin/,
    );
    expect(() => encodeEscPos([{ t: 'qr', data: 'é' }], opts)).toThrow(/ASCII/);
    expect(() =>
      encodeEscPos([{ t: 'qr', data: 'x' }], { ...opts, qrModuleSize: 0 }),
    ).toThrow(/module size/);
    expect(() =>
      encodeEscPos([{ t: 'qr', data: 'x'.repeat(70_000) }], opts),
    ).toThrow(/too long/);
  });

  it('skips the logo when no bitmap is given and an empty QR', () => {
    const bytes = encodeEscPos([{ t: 'logo' }, { t: 'qr', data: '' }], opts);
    expect([...bytes]).toEqual([0x1b, 0x40, 0x1b, 0x74, 0x00]);
  });

  it('fits an explicit image block to the paper (scaled down, left-aligned, dithered on request)', () => {
    const wide = encodeEscPos([{ t: 'image', source: gray(1000, 10) }], opts);
    expect([...wide.subarray(5, 13)]).toEqual([
      0x1d, 0x76, 0x30, 0x00, 72, 0, 6, 0,
    ]);
    const narrow = encodeEscPos(
      [{ t: 'image', source: gray(8, 2, 128), dither: true }],
      { charsPerLine: 32, dots: 384 },
    );
    expect([...narrow.subarray(5, 13)]).toEqual([
      0x1d, 0x76, 0x30, 0x00, 48, 0, 2, 0,
    ]);
  });

  it('renders double-size Urdu with RTL through the renderer', () => {
    const blocks: Block[] = [
      { t: 'text', text: 'شکریہ', size: 'double', align: 'right', bold: true },
    ];
    const bytes = encodeEscPos(blocks, {
      ...opts,
      renderer: createFakeRasterRenderer(),
    });
    expect([...bytes.subarray(5, 13)]).toEqual([
      0x1d, 0x76, 0x30, 0x00, 72, 0, 16, 0,
    ]);
  });
});

describe('layout guards', () => {
  it('rejects bad rules, narrow column layouts and bad widths', () => {
    expect(() =>
      layOut([{ t: 'rule', char: '*' as '-' }], {
        charsPerLine: 32,
        itemLayout: 'stacked',
      }),
    ).toThrow(/rule/);
    expect(() => columnWidths(19)).toThrow();
    expect(() => formatPair('a', 'b', 0)).toThrow();
    expect(() => resolvePaper({ charsPerLine: 0 })).toThrow();
    expect(() => resolvePaper({ dots: 1.5 })).toThrow();
  });
});

describe('raster guards', () => {
  it('rejects bad sizes and formats', () => {
    expect(() => packMono(gray(0, 1), 'threshold')).toThrow();
    expect(() => packMono({ ...gray(2, 2), height: 0 }, 'threshold')).toThrow();
    expect(() =>
      packMono(
        { width: 2, height: 2, data: new Uint8Array(3), format: 'gray' },
        'threshold',
      ),
    ).toThrow();
    expect(() =>
      packMono(
        { width: 1, height: 1, data: new Uint8Array(3), format: 'rgba' },
        'threshold',
      ),
    ).toThrow();
    expect(() =>
      packMono(
        {
          width: 1,
          height: 1,
          data: new Uint8Array(1),
          format: 'bgr' as 'gray',
        },
        'threshold',
      ),
    ).toThrow();
    expect(() =>
      encodeGsV0({ widthBytes: 0, height: 1, data: new Uint8Array(1) }),
    ).toThrow();
    expect(() =>
      encodeGsV0({ widthBytes: 1, height: 0, data: new Uint8Array(1) }),
    ).toThrow();
    expect(() => prepareLogo(gray(2, 2), 4)).toThrow();
    expect(() => fitRasterToDots(gray(2, 2), 0)).toThrow();
    expect(() => fitRasterToDots(gray(10, 2), 8)).toThrow(/wider/);
    expect(fitRasterToDots(gray(8, 1), 8).width).toBe(8);
  });

  it('centres a narrow bitmap and leaves a full-width one alone', () => {
    const centred = centerOnWidth(gray(2, 1), 6);
    expect([...centred.data]).toEqual([255, 255, 0, 0, 255, 255]);
    expect(centerOnWidth(gray(6, 1), 6).width).toBe(6);
    expect(scaleToFit(gray(400, 10), 200, 160).width).toBe(200);
  });
});
