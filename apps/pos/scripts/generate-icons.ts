import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');

const letterB = `
  <path fill="#FFFFFF" fill-rule="evenodd" d="
    M148 88
    H270
    C348 88 400 132 400 188
    C400 234 360 270 300 278
    C368 288 414 332 414 392
    C414 456 352 496 260 496
    H148 Z
    M212 148
    H262
    C304 148 336 164 336 190
    C336 216 304 232 262 232
    H212 Z
    M212 332
    H270
    C320 332 352 350 352 384
    C352 418 320 436 270 436
    H212 Z"/>
`;

function icon(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${inner}
</svg>`;
}

const anySvg = icon(`
  <rect width="512" height="512" rx="96" fill="#006BB3"/>
  <g transform="translate(0 -8)">${letterB}</g>
`);

const maskableSvg = icon(`
  <rect width="512" height="512" fill="#006BB3"/>
  <g transform="translate(256 256) scale(0.68) translate(-256 -256)">
    ${letterB}
  </g>
`);

await mkdir(outDir, { recursive: true });
const anyPng = await sharp(Buffer.from(anySvg)).png().toBuffer();
await sharp(anyPng).resize(512, 512).png().toFile(join(outDir, 'icon-512.png'));
await sharp(anyPng).resize(192, 192).png().toFile(join(outDir, 'icon-192.png'));
await sharp(Buffer.from(maskableSvg))
  .resize(512, 512)
  .png()
  .toFile(join(outDir, 'icon-maskable-512.png'));
