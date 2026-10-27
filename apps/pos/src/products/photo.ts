/** Product photo (screens/08): square crop, 512×512 WebP q 0.8, ≤ 150 KB. */
export const PHOTO_SIZE = 512;
export const PHOTO_MAX_BYTES = 150 * 1024;
const QUALITIES = [0.8, 0.7, 0.6, 0.5, 0.4];

export class PhotoError extends Error {
  constructor() {
    super('could not read this image');
    this.name = 'PhotoError';
  }
}

export type Photo = { blob: Blob; sha256: string; ext: 'webp' | 'jpg' };

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await blob.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Relative key stored in `products.image_key` (no tenant; the server adds `t/<tenant_id>/`). */
export function photoKey(
  productId: string,
  photo: Pick<Photo, 'sha256' | 'ext'>,
): string {
  return `products/${productId}/${photo.sha256}.${photo.ext}`;
}

/** Centre square of a w×h image. */
export function squareCrop(
  width: number,
  height: number,
): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return {
    sx: Math.round((width - side) / 2),
    sy: Math.round((height - side) / 2),
    side,
  };
}

/**
 * Encodes at falling quality until ≤ 150 KB. Browsers that cannot encode WebP (older Safari
 * returns PNG) fall back to JPEG (D-092).
 */
export async function encodeUnderLimit(
  encode: (type: string, quality: number) => Promise<Blob | null>,
): Promise<Pick<Photo, 'blob' | 'ext'>> {
  let last: Blob | null = null;
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const q of QUALITIES) {
      const blob = await encode(type, q);
      if (!blob || blob.type !== type) break;
      last = blob;
      if (blob.size <= PHOTO_MAX_BYTES)
        return { blob, ext: type === 'image/webp' ? 'webp' : 'jpg' };
    }
    if (last)
      return { blob: last, ext: last.type === 'image/webp' ? 'webp' : 'jpg' };
  }
  throw new PhotoError();
}

/* v8 ignore start -- canvas and image decoding need a real browser (covered by e2e). */
export async function processPhoto(file: Blob): Promise<Photo> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new PhotoError();
  });
  const { sx, sy, side } = squareCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoError();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  bitmap.close();
  const { blob, ext } = await encodeUnderLimit(
    (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q)),
  );
  return { blob, ext, sha256: await sha256Hex(blob) };
}
/* v8 ignore stop */
