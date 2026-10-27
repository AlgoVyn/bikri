import { packMono, prepareLogo } from '@bikri/printer';
import type { LogoData } from '../data/setup.ts';

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MAX_WIDTH = 576;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);

export class LogoError extends Error {
  constructor() {
    super('logo must be PNG, JPG or SVG up to 2 MB');
    this.name = 'LogoError';
  }
}

export type ProcessedLogo = LogoData & {
  /** Resized logo (data URL), ≤ 576 px wide. */
  url: string;
  /** 1-bit dithered thermal look at 80 mm (data URL). */
  previewUrl: string;
};

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new LogoError());
    };
    img.src = url;
  });
}

function canvas(
  width: number,
  height: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new LogoError();
  return [c, ctx];
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await blob.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** screens/01 step 3: resize to ≤ 576 px wide, PNG for R2, gray bitmap for the printer. */
export async function processLogo(file: File): Promise<ProcessedLogo> {
  if (!TYPES.has(file.type) || file.size > LOGO_MAX_BYTES)
    throw new LogoError();
  const img = await loadImage(file);
  const natural = img.naturalWidth || LOGO_MAX_WIDTH;
  const width = Math.min(LOGO_MAX_WIDTH, natural);
  const height = Math.max(
    1,
    Math.round(((img.naturalHeight || natural) * width) / natural),
  );
  const [c, ctx] = canvas(width, height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const png = await new Promise<Blob>((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new LogoError())), 'image/png');
  });
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = Math.round(
      0.299 * (rgba[i * 4] ?? 255) +
        0.587 * (rgba[i * 4 + 1] ?? 255) +
        0.114 * (rgba[i * 4 + 2] ?? 255),
    );
  }
  const bitmap = { width, height, data: gray, format: 'gray' as const };
  return {
    png,
    sha256: await sha256Hex(png),
    bitmap,
    url: c.toDataURL('image/png'),
    previewUrl: ditheredPreview(bitmap),
  };
}

/** What the printer will print: prepareLogo at 576 dots, Floyd–Steinberg to 1 bit. */
export function ditheredPreview(bitmap: LogoData['bitmap']): string {
  const fitted = prepareLogo(bitmap, 576);
  const packed = packMono(fitted, 'dither');
  const [c, ctx] = canvas(fitted.width, fitted.height);
  const image = ctx.createImageData(fitted.width, fitted.height);
  for (let y = 0; y < fitted.height; y += 1) {
    for (let x = 0; x < fitted.width; x += 1) {
      const byte = packed.data[y * packed.widthBytes + (x >> 3)] ?? 0;
      const v = byte & (1 << (7 - (x & 7))) ? 0 : 255;
      const o = (y * fitted.width + x) * 4;
      image.data[o] = v;
      image.data[o + 1] = v;
      image.data[o + 2] = v;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return c.toDataURL('image/png');
}
