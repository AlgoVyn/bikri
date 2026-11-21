import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE_PATH, renderAssetHeaders } from '@bikri/core';

export async function writeAssetShell(distDir: string): Promise<void> {
  const baseDir = resolve(distDir, BASE_PATH.replace(/^\//u, ''));
  const nestedIndex = resolve(baseDir, 'index.html');
  // tsc used to emit declarations into dist/types and dist/types-node. Remove a local
  // leftover so wrangler never uploads the declaration files as static assets.
  await rm(resolve(distDir, 'types'), { recursive: true, force: true });
  await rm(resolve(distDir, 'types-node'), { recursive: true, force: true });
  await mkdir(dirname(resolve(distDir, 'index.html')), { recursive: true });
  await copyFile(nestedIndex, resolve(distDir, 'index.html'));
  await rm(resolve(baseDir, '.gitkeep'), { force: true });
  await writeFile(resolve(distDir, '_headers'), renderAssetHeaders(), 'utf8');
}

const entry = process.argv[1];
const ranAsCli =
  entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;

if (ranAsCli) {
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
  await writeAssetShell(distDir);
}
