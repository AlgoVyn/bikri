import type { RasterSource } from './types.ts';

/** 1-bit rows, MSB first, 1 = black. `widthBytes` is `ceil(width / 8)`. */
export type PackedBitmap = {
  widthBytes: number;
  height: number;
  data: Uint8Array;
};

const BLACK_BELOW = 128;

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

function toLuma(source: RasterSource): Float64Array {
  assertSize(source.width, source.height);
  const count = source.width * source.height;
  const out = new Float64Array(count);
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
  buf: Float64Array,
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

/** Floyd–Steinberg. 1 = black. Errors use exact sixteenths. */
function ditherBits(
  luma: Float64Array,
  width: number,
  height: number,
): Uint8Array {
  const buf = new Float64Array(luma);
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const old = buf[index] ?? 0;
      const black = old < BLACK_BELOW;
      bits[index] = black ? 1 : 0;
      const err = old - (black ? 0 : 255);
      spread(buf, width, height, x + 1, y, err * (7 / 16));
      spread(buf, width, height, x - 1, y + 1, err * (3 / 16));
      spread(buf, width, height, x, y + 1, err * (5 / 16));
      spread(buf, width, height, x + 1, y + 1, err * (1 / 16));
    }
  }
  return bits;
}

function thresholdBits(
  luma: Float64Array,
  width: number,
  height: number,
): Uint8Array {
  const bits = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    bits[i] = (luma[i] ?? 255) < BLACK_BELOW ? 1 : 0;
  }
  return bits;
}

function packBits(
  bits: Uint8Array,
  width: number,
  height: number,
): PackedBitmap {
  const widthBytes = Math.ceil(width / 8);
  const data = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (bits[y * width + x] !== 1) {
        continue;
      }
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
  const luma = toLuma(source);
  const bits =
    mode === 'dither'
      ? ditherBits(luma, source.width, source.height)
      : thresholdBits(luma, source.width, source.height);
  return packBits(bits, source.width, source.height);
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

/** Downscale to fit. Never upscales. Result is gray. */
export function scaleToFit(
  source: RasterSource,
  maxWidth: number,
  maxHeight: number,
): RasterSource {
  const luma = toLuma(source);
  const { width, height } = source;
  if (maxWidth < 1 || maxHeight < 1) {
    throw new Error('scale target must be positive');
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  if (targetWidth === width && targetHeight === height) {
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = clampByte(luma[i] ?? 255);
    }
    return { width, height, data, format: 'gray' };
  }
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
