import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('self-hosted PWA assets', () => {
  it('loads the pre-paint theme without an inline script', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const html = await readFile(join(root, 'index.html'), 'utf8');
    expect(html).toContain('src="%BASE_URL%theme-init.js"');
    const inline = [
      ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi),
    ].filter((match) => {
      const attrs = match[1] ?? '';
      const body = match[2] ?? '';
      return !/\bsrc\s*=/i.test(attrs) && body.trim() !== '';
    });
    expect(inline).toEqual([]);
    const theme = await readFile(join(publicDir, 'theme-init.js'), 'utf8');
    expect(theme).toContain("localStorage.getItem('bikri.theme')");
    expect(theme).toContain('document.documentElement.dataset.theme = theme');
  });

  it('ships OFL licences and woff2 faces', async () => {
    for (const name of [
      'OFL-inter.txt',
      'OFL-noto-nastaliq-urdu.txt',
      'OFL-jetbrains-mono.txt',
    ]) {
      const text = await readFile(join(publicDir, 'fonts', name), 'utf8');
      expect(text).toContain('SIL Open Font License');
    }
    for (const name of [
      'inter-latin-wght-normal.woff2',
      'noto-nastaliq-urdu-arabic-400-normal.woff2',
      'noto-nastaliq-urdu-arabic-700-normal.woff2',
      'jetbrains-mono-latin-wght-normal.woff2',
    ]) {
      const bytes = await readFile(join(publicDir, 'fonts', name));
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
    }
  });

  it('ships an original B mark at the manifest sizes', async () => {
    expect(
      pngSize(await readFile(join(publicDir, 'icons/icon-192.png'))),
    ).toEqual({
      width: 192,
      height: 192,
    });
    expect(
      pngSize(await readFile(join(publicDir, 'icons/icon-512.png'))),
    ).toEqual({
      width: 512,
      height: 512,
    });
    expect(
      pngSize(await readFile(join(publicDir, 'icons/icon-maskable-512.png'))),
    ).toEqual({
      width: 512,
      height: 512,
    });
  });
});
