import type { RasterSource } from './types.ts';

/** 1-bit rows, MSB first, 1 = black. `widthBytes` is `ceil(width / 8)`. */
export type PackedBitmap = {
  widthBytes: number;
  height: number;
  data: Uint8Array;
};

const BLACK_BELOW = 128;

/** Pixel storage accepted by `RasterSource`; both expose the same indexing. */
type RasterBytes = Uint8Array | Uint8ClampedArray;

function assertSize(width: number, height: number): void {
  if (!Number.isInteger(width) || width < 1) {
    throw new Error('raster width must be a positive integer');
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error('raster height must be a positive integer');
  }
}

/** Blend over white, then return 0–255 luminance. */
function blendedLuma(r: number, g: number, b: number, a: number): number {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (a >= 255) {
    return y;
  }
  if (a <= 0) {
    return 255;
  }
  return (y * a + 255 * (255 - a)) / 255;
}

function toLuma(source: RasterSource): Float32Array {
  assertSize(source.width, source.height);
  const count = source.width * source.height;
  const out = new Float32Array(count);
  const format = source.format as string;
  if (format === 'gray') {
    if (source.data.length !== count) {
      throw new Error('gray buffer length does not match width*height');
    }
    for (let i = 0; i < count; i += 1) {
      out[i] = source.data[i] ?? 255;
    }
    return out;
  }
  if (format !== 'rgba') {
    throw new Error('unsupported raster format');
  }
  if (source.data.length !== count * 4) {
    throw new Error('RGBA buffer length does not match width*height*4');
  }
  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    out[i] = blendedLuma(
      source.data[offset] ?? 0,
      source.data[offset + 1] ?? 0,
      source.data[offset + 2] ?? 0,
      source.data[offset + 3] ?? 255,
    );
  }
  return out;
}

function spread(
  buf: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  value: number,
): void {
  if (x < 0 || x >= width || y >= height) {
    return;
  }
  const index = y * width + x;
  buf[index] = (buf[index] ?? 0) + value;
}

/**
 * Floyd–Steinberg. 1 = black. Errors use exact sixteenths.
 *
 * The luma buffer is a private copy owned by the caller, so it is diffused in
 * place. The 1-bit output is packed as each pixel is decided: allocating a
 * second `Float32Array`, a `Uint8Array` of bits and then another packed buffer
 * was three full-image copies per logo (M17.2).
 */
function ditherPacked(
  luma: Float32Array,
  width: number,
  height: number,
): PackedBitmap {
  const widthBytes = Math.ceil(width / 8);
  const data = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const old = luma[index] ?? 0;
      const black = old < BLACK_BELOW;
      if (black) {
        const byteIndex = y * widthBytes + (x >> 3);
        data[byteIndex] = (data[byteIndex] ?? 0) | (1 << (7 - (x & 7)));
      }
      const err = old - (black ? 0 : 255);
      spread(luma, width, height, x + 1, y, err * (7 / 16));
      spread(luma, width, height, x - 1, y + 1, err * (3 / 16));
      spread(luma, width, height, x, y + 1, err * (5 / 16));
      spread(luma, width, height, x + 1, y + 1, err * (1 / 16));
    }
  }
  return { widthBytes, height, data };
}

/**
 * Opaque grayscale RGBA (the Urdu canvas raster and most logos) can be packed
 * from one channel: `blendedLuma` with r = g = b returns the same floating
 * expression, minus the alpha branches and the other two channel reads. Pure
 * black/white dominates and skips the multiply entirely. Returns null when any
 * pixel is translucent or coloured, so the general path still decides those.
 */
function packOpaqueGrayRgba(
  pixels: RasterBytes,
  width: number,
  height: number,
  widthBytes: number,
): Uint8Array | null {
  const data = new Uint8Array(widthBytes * height);
  let index = 0;
  for (let y = 0; y < height; y += 1) {
    let byteIndex = y * widthBytes;
    for (let x = 0; x < width; x += 1) {
      const offset = index * 4;
      const r = pixels[offset] ?? 0;
      const g = pixels[offset + 1] ?? 0;
      const b = pixels[offset + 2] ?? 0;
      const a = pixels[offset + 3] ?? 0;
      if (a !== 255 || r !== g || g !== b) {
        return null;
      }
      // Same operand order as blendedLuma, so v = 128 still rounds below 128.
      const black =
        r === 0
          ? true
          : r === 255
            ? false
            : 0.299 * r + 0.587 * g + 0.114 * b < BLACK_BELOW;
      if (black) {
        data[byteIndex] = (data[byteIndex] ?? 0) | (1 << (7 - (x & 7)));
      }
      if ((x & 7) === 7) byteIndex += 1;
      index += 1;
    }
  }
  return data;
}

/** Grayscale black-or-white fast path; null means a pixel needs the threshold. */
function packOpaqueMonoGray(
  pixels: RasterBytes,
  width: number,
  height: number,
  widthBytes: number,
): Uint8Array | null {
  const data = new Uint8Array(widthBytes * height);
  let index = 0;
  for (let y = 0; y < height; y += 1) {
    let byteIndex = y * widthBytes;
    for (let x = 0; x < width; x += 1) {
      const value = pixels[index] ?? 255;
      if (value !== 0 && value !== 255) return null;
      if (value === 0) {
        data[byteIndex] = (data[byteIndex] ?? 0) | (1 << (7 - (x & 7)));
      }
      if ((x & 7) === 7) byteIndex += 1;
      index += 1;
    }
  }
  return data;
}

/** 1-bit threshold straight from the source pixels; no full-image luma buffer. */
function thresholdPacked(source: RasterSource): PackedBitmap {
  assertSize(source.width, source.height);
  const { width, height } = source;
  const widthBytes = Math.ceil(width / 8);
  const format = source.format as string;
  if (format === 'gray') {
    if (source.data.length !== width * height)
      throw new Error('gray buffer length does not match width*height');
    const mono = packOpaqueMonoGray(source.data, width, height, widthBytes);
    if (mono !== null) return { widthBytes, height, data: mono };
    const data = new Uint8Array(widthBytes * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((source.data[y * width + x] ?? 255) >= BLACK_BELOW) continue;
        const byteIndex = y * widthBytes + (x >> 3);
        data[byteIndex] = (data[byteIndex] ?? 0) | (1 << (7 - (x & 7)));
      }
    }
    return { widthBytes, height, data };
  }
  if (format !== 'rgba') throw new Error('unsupported raster format');
  if (source.data.length !== width * height * 4)
    throw new Error('RGBA buffer length does not match width*height*4');
  const mono = packOpaqueGrayRgba(source.data, width, height, widthBytes);
  if (mono !== null) return { widthBytes, height, data: mono };
  const data = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const luma = blendedLuma(
        source.data[offset] ?? 0,
        source.data[offset + 1] ?? 0,
        source.data[offset + 2] ?? 0,
        source.data[offset + 3] ?? 255,
      );
      if (luma >= BLACK_BELOW) continue;
      const byteIndex = y * widthBytes + (x >> 3);
      data[byteIndex] = (data[byteIndex] ?? 0) | (1 << (7 - (x & 7)));
    }
  }
  return { widthBytes, height, data };
}

/** Threshold (text) or Floyd–Steinberg (logos). Pads the last byte with white bits. */
export function packMono(
  source: RasterSource,
  mode: 'threshold' | 'dither',
): PackedBitmap {
  if (mode === 'threshold') return thresholdPacked(source);
  const luma = toLuma(source);
  return ditherPacked(luma, source.width, source.height);
}

/**
 * `GS v 0`: `1D 76 30 00 xL xH yL yH data`.
 * Width is in bytes. Bands are at most 255 rows.
 */
export function encodeGsV0(packed: PackedBitmap): Uint8Array {
  if (
    !Number.isInteger(packed.widthBytes) ||
    packed.widthBytes < 1 ||
    packed.widthBytes > 65535
  ) {
    throw new Error('raster width is out of range');
  }
  if (!Number.isInteger(packed.height) || packed.height < 1) {
    throw new Error('raster height is out of range');
  }
  const needed = packed.widthBytes * packed.height;
  if (packed.data.length < needed) {
    throw new Error('raster data is shorter than width*height');
  }
  const parts: Uint8Array[] = [];
  const xL = packed.widthBytes & 0xff;
  const xH = (packed.widthBytes >> 8) & 0xff;
  let row = 0;
  while (row < packed.height) {
    const band = Math.min(255, packed.height - row);
    const header = new Uint8Array([
      0x1d,
      0x76,
      0x30,
      0x00,
      xL,
      xH,
      band & 0xff,
      (band >> 8) & 0xff,
    ]);
    const start = row * packed.widthBytes;
    const body = packed.data.subarray(start, start + band * packed.widthBytes);
    parts.push(header, body);
    row += band;
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function clampByte(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 255) {
    return 255;
  }
  return Math.round(value);
}

/**
 * Downscale to fit. Never upscales. Result is gray.
 * Targets must be finite; NaN slipped through the `< 1` comparison and produced
 * an empty bitmap. The same-size fast path checks the gray buffer length too,
 * so a truncated logo is rejected instead of printed as garbage.
 */
export function scaleToFit(
  source: RasterSource,
  maxWidth: number,
  maxHeight: number,
): RasterSource {
  const { width, height } = source;
  if (
    !Number.isFinite(maxWidth) ||
    !Number.isFinite(maxHeight) ||
    maxWidth < 1 ||
    maxHeight < 1
  ) {
    throw new Error('scale target must be positive');
  }
  assertSize(width, height);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  if (targetWidth === width && targetHeight === height) {
    if (source.format === 'gray') {
      if (source.data.length < width * height) {
        throw new Error('gray buffer length does not match width*height');
      }
      return source;
    }
    const luma = toLuma(source);
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = clampByte(luma[i] ?? 255);
    }
    return { width, height, data, format: 'gray' };
  }
  const luma = toLuma(source);
  const data = new Uint8Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = (y * height) / targetHeight;
    const y1 = ((y + 1) * height) / targetHeight;
    const yStart = Math.floor(y0);
    const yEnd = Math.min(height, Math.max(yStart + 1, Math.ceil(y1)));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = (x * width) / targetWidth;
      const x1 = ((x + 1) * width) / targetWidth;
      const xStart = Math.floor(x0);
      const xEnd = Math.min(width, Math.max(xStart + 1, Math.ceil(x1)));
      let sum = 0;
      let count = 0;
      for (let sy = yStart; sy < yEnd; sy += 1) {
        for (let sx = xStart; sx < xEnd; sx += 1) {
          sum += luma[sy * width + sx] ?? 255;
          count += 1;
        }
      }
      data[y * targetWidth + x] = clampByte(sum / count);
    }
  }
  return { width: targetWidth, height: targetHeight, data, format: 'gray' };
}

/** Place `source` on a white canvas `dots` wide. Extra space is split to the left. */
export function centerOnWidth(
  source: RasterSource,
  dots: number,
): RasterSource {
  if (!Number.isInteger(dots) || dots < 1) {
    throw new Error('dots must be a positive integer');
  }
  const gray = scaleToFit(source, source.width, source.height);
  if (gray.width > dots) {
    throw new Error('image is wider than the paper');
  }
  if (gray.width === dots) {
    return gray;
  }
  const data = new Uint8Array(dots * gray.height);
  data.fill(255);
  const x0 = Math.floor((dots - gray.width) / 2);
  for (let y = 0; y < gray.height; y += 1) {
    const row = gray.data.subarray(y * gray.width, (y + 1) * gray.width);
    data.set(row, y * dots + x0);
  }
  return { width: dots, height: gray.height, data, format: 'gray' };
}

/**
 * Logo for the printer: at most 60% of `dots` wide and 160 px tall, centered
 * on the paper. Caller dithers the result.
 */
export function prepareLogo(source: RasterSource, dots: number): RasterSource {
  if (!Number.isInteger(dots) || dots < 8) {
    throw new Error('dots must be an integer >= 8');
  }
  const maxWidth = Math.max(1, Math.min(dots, Math.floor(dots * 0.6)));
  const scaled = scaleToFit(source, maxWidth, 160);
  return centerOnWidth(scaled, dots);
}

/**
 * Bounded cache of packed `GS v 0` logo bytes. A logo is re-scaled and
 * re-dithered on every receipt, yet the shop logo and the paper width rarely
 * change, so the finished bytes are reused (M17.2). The key includes the pixel
 * hash, dimensions, format and target width; a caller must not mutate a logo's
 * data buffer after printing it (the device logo comes from IndexedDB, which
 * returns a fresh buffer per read).
 */
const LOGO_CACHE_MAX = 8;
const logoCache = new Map<string, Uint8Array>();

function hashRasterData(data: RasterBytes): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i] ?? 0;
    h1 = Math.imul(h1 ^ value, 0x01000193);
    h2 = Math.imul(h2 ^ (value + 0x9e), 0x85ebca6b) ^ (h2 >>> 13);
  }
  return `${h1 >>> 0}:${h2 >>> 0}`;
}

/** Packed and encoded logo for `dots`, cached by logo pixels and target width. */
export function logoGsV0(source: RasterSource, dots: number): Uint8Array {
  if (!Number.isInteger(dots) || dots < 8) {
    throw new Error('dots must be an integer >= 8');
  }
  const key = [
    dots,
    source.format,
    source.width,
    source.height,
    source.data.length,
    hashRasterData(source.data),
  ].join(':');
  const cached = logoCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const bytes = encodeGsV0(packMono(prepareLogo(source, dots), 'dither'));
  if (logoCache.size >= LOGO_CACHE_MAX) {
    const oldest = logoCache.keys().next().value;
    if (oldest !== undefined) {
      logoCache.delete(oldest);
    }
  }
  logoCache.set(key, bytes);
  return bytes;
}

/** Left-align a narrower text bitmap on a white `dots`-wide canvas. */
export function fitRasterToDots(
  source: RasterSource,
  dots: number,
): RasterSource {
  if (!Number.isInteger(dots) || dots < 1) {
    throw new Error('dots must be a positive integer');
  }
  if (source.width === dots) {
    return source;
  }
  if (source.width > dots) {
    throw new Error('rendered line is wider than the paper');
  }
  const gray = scaleToFit(source, source.width, source.height);
  const data = new Uint8Array(dots * gray.height);
  data.fill(255);
  for (let y = 0; y < gray.height; y += 1) {
    const row = gray.data.subarray(y * gray.width, (y + 1) * gray.width);
    data.set(row, y * dots);
  }
  return { width: dots, height: gray.height, data, format: 'gray' };
}
