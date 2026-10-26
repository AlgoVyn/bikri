import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderAssetHeaders } from '@bikri/core';

export async function writeAssetShell(distDir: string): Promise<void> {
  const nestedIndex = resolve(distDir, 'bikri/index.html');
  await mkdir(dirname(resolve(distDir, 'index.html')), { recursive: true });
  await copyFile(nestedIndex, resolve(distDir, 'index.html'));
  await rm(resolve(distDir, 'bikri/.gitkeep'), { force: true });
  await writeFile(resolve(distDir, '_headers'), renderAssetHeaders(), 'utf8');
}

const entry = process.argv[1];
const ranAsCli =
  entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;

if (ranAsCli) {
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
  await writeAssetShell(distDir);
}
