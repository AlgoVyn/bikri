import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps/pos/src');
const SCANNED = /\.(?:ts|tsx|css)$/u;
// Raw colours are allowed where the value is a document/raster format rather than a UI
// token: the QR matrix, monochrome receipt and label output, the canvas palette, the
// logo raster and the token declarations themselves.
const ALLOW = new Set([
  'components/QrCode.tsx',
  'labels/printLabels.ts',
  'lib/palette.ts',
  'print/canvasRaster.ts',
  'print/receiptImage.ts',
  'lib/logo.ts',
  'styles/tokens.css',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SCANNED.test(entry.name) ? [path] : [];
  });
}

describe('design tokens', () => {
  it('does not use raw colours in components or styles', () => {
    const problems: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (ALLOW.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b/gu)) {
        problems.push(`${rel}: ${match[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('does not use arbitrary colour utilities', () => {
    const problems: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (ALLOW.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /(?:bg|text|border|ring|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]/gu,
      )) {
        problems.push(`${rel}: ${match[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
