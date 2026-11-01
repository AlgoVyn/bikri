import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/fonts');

function packageRoot(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

const copies: ReadonlyArray<readonly [string, string]> = [
  [
    join(
      packageRoot('@fontsource-variable/inter'),
      'files/inter-latin-wght-normal.woff2',
    ),
    'inter-latin-wght-normal.woff2',
  ],
  [join(packageRoot('@fontsource-variable/inter'), 'LICENSE'), 'OFL-inter.txt'],
  [
    join(
      packageRoot('@fontsource/noto-naskh-arabic'),
      'files/noto-naskh-arabic-arabic-400-normal.woff2',
    ),
    'noto-naskh-arabic-arabic-400-normal.woff2',
  ],
  [
    join(
      packageRoot('@fontsource/noto-naskh-arabic'),
      'files/noto-naskh-arabic-arabic-600-normal.woff2',
    ),
    'noto-naskh-arabic-arabic-600-normal.woff2',
  ],
  [
    join(
      packageRoot('@fontsource/noto-naskh-arabic'),
      'files/noto-naskh-arabic-arabic-700-normal.woff2',
    ),
    'noto-naskh-arabic-arabic-700-normal.woff2',
  ],
  [
    join(packageRoot('@fontsource/noto-naskh-arabic'), 'LICENSE'),
    'OFL-noto-naskh-arabic.txt',
  ],
  [
    join(
      packageRoot('@fontsource-variable/jetbrains-mono'),
      'files/jetbrains-mono-latin-wght-normal.woff2',
    ),
    'jetbrains-mono-latin-wght-normal.woff2',
  ],
  [
    join(packageRoot('@fontsource-variable/jetbrains-mono'), 'LICENSE'),
    'OFL-jetbrains-mono.txt',
  ],
];

await mkdir(outDir, { recursive: true });
for (const [from, name] of copies) {
  await copyFile(from, join(outDir, name));
}
