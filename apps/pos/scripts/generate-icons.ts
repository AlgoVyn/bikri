// Rasterises the Bikri brand mark (ledger with a cut-out tick, D-216) into the PWA icons,
// favicons and Apple touch icon under public/. The vector masters live in scripts/brand/:
//   app-icon.svg  rounded navy tile, for manifest purpose "any"
//   maskable.svg  full-bleed tile with the book inside the 80% safe circle (also the Apple
//                 touch icon, which iOS rounds itself)
//   favicon.svg   small-size master: a wider tick cut and heavier total line for 16-48 px
// Run with `node scripts/generate-icons.ts` from apps/pos after changing a master.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const brandDir = join(here, 'brand');
const publicDir = join(here, '../public');
const iconsDir = join(publicDir, 'icons');

async function master(name: string): Promise<Buffer> {
  return readFile(join(brandDir, name));
}

async function png(svg: Buffer, size: number): Promise<Buffer> {
  return sharp(svg, { density: 300 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** A PNG-compressed .ico (Vista+ format): ICONDIR + one ICONDIRENTRY per image + the PNGs. */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

await mkdir(iconsDir, { recursive: true });
const appIcon = await master('app-icon.svg');
const maskable = await master('maskable.svg');
const favicon = await master('favicon.svg');

await writeFile(join(iconsDir, 'app-icon-192.png'), await png(appIcon, 192));
await writeFile(join(iconsDir, 'app-icon-512.png'), await png(appIcon, 512));
await writeFile(join(iconsDir, 'maskable-192.png'), await png(maskable, 192));
await writeFile(join(iconsDir, 'maskable-512.png'), await png(maskable, 512));
await writeFile(
  join(iconsDir, 'apple-touch-icon.png'),
  await png(maskable, 180),
);
await copyFile(join(brandDir, 'favicon.svg'), join(publicDir, 'favicon.svg'));
await writeFile(
  join(publicDir, 'favicon.ico'),
  ico(
    await Promise.all(
      [16, 32, 48].map(async (size) => ({
        size,
        data: await png(favicon, size),
      })),
    ),
  ),
);
