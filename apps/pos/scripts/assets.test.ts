import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS } from '@bikri/core';
import { describe, expect, it } from 'vitest';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('self-hosted PWA assets', () => {
  it('inlines the pre-paint theme under a CSP hash', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const html = await readFile(join(root, 'index.html'), 'utf8');
    const inline = [
      ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi),
    ].filter((match) => {
      const attrs = match[1] ?? '';
      const body = match[2] ?? '';
      return !/\bsrc\s*=/i.test(attrs) && body.trim() !== '';
    });
    expect(inline).toHaveLength(1);
    const body = inline[0]?.[2] ?? '';
    expect(body).toContain("localStorage.getItem('bikri.theme')");
    expect(body).toContain('document.documentElement.dataset.theme = theme');
    const hash = createHash('sha256').update(body).digest('base64');
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain(
      `'sha256-${hash}'`,
    );
    await expect(
      readFile(join(publicDir, 'theme-init.js'), 'utf8'),
    ).rejects.toThrow();
  });

  it('ships OFL licences and woff2 faces', async () => {
    for (const name of [
      'OFL-inter.txt',
      'OFL-noto-naskh-arabic.txt',
      'OFL-jetbrains-mono.txt',
    ]) {
      const text = await readFile(join(publicDir, 'fonts', name), 'utf8');
      expect(text).toContain('SIL Open Font License');
    }
    for (const name of [
      'inter-latin-wght-normal.woff2',
      'noto-naskh-arabic-arabic-wght-normal.woff2',
      'jetbrains-mono-latin-wght-normal.woff2',
    ]) {
      const bytes = await readFile(join(publicDir, 'fonts', name));
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
    }
  });

  it('ships the ledger mark at the manifest and Apple touch sizes (D-216)', async () => {
    for (const [name, size] of [
      ['icons/app-icon-192.png', 192],
      ['icons/app-icon-512.png', 512],
      ['icons/maskable-192.png', 192],
      ['icons/maskable-512.png', 512],
      ['icons/apple-touch-icon.png', 180],
    ] as const) {
      expect(pngSize(await readFile(join(publicDir, name)))).toEqual({
        width: size,
        height: size,
      });
    }
  });

  it('ships an SVG favicon and a 16/32/48 .ico linked from index.html', async () => {
    const svg = await readFile(join(publicDir, 'favicon.svg'), 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).not.toMatch(/<script|<text|href="http/i);
    const ico = await readFile(join(publicDir, 'favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) =>
      ico.readUInt8(6 + 16 * i),
    );
    expect(sizes).toEqual([16, 32, 48]);
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const html = await readFile(join(root, 'index.html'), 'utf8');
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('href="/favicon.svg" type="image/svg+xml"');
    expect(html).toContain(
      '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
    );
  });
});
