import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps/pos/src');
const ALLOW = new Set(['components/QrCode.tsx']);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('design tokens', () => {
  it('does not use raw colours in components', () => {
    const problems: string[] = [];
    for (const file of tsxFiles(SRC)) {
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
    for (const file of tsxFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
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
