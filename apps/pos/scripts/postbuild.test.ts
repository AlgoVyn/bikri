import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAssetHeaders, SECURITY_HEADERS } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { writeAssetShell } from './postbuild.ts';

describe('writeAssetShell', () => {
  it('copies the shell and writes the shared security headers', async () => {
    const distDir = await mkdtemp(join(tmpdir(), 'bikri-pos-'));
    await mkdir(join(distDir, 'bikri'), { recursive: true });
    const shell = '<!doctype html><title>Bikri</title>';
    await writeFile(join(distDir, 'bikri/index.html'), shell, 'utf8');

    await writeAssetShell(distDir);

    expect(await readFile(join(distDir, 'index.html'), 'utf8')).toBe(shell);
    const headers = await readFile(join(distDir, '_headers'), 'utf8');
    expect(headers).toBe(renderAssetHeaders());
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers).toContain(`  ${name}: ${value}`);
    }
  });
});
