import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOCALE_FILES = ['en', 'ur', 'roman-ur'] as const;

export function flattenKeys(value: unknown, prefix = ''): Map<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      prefix === '' ? 'catalog must be an object' : `bad value at ${prefix}`,
    );
  }
  const flat = new Map<string, string>();
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof child === 'string') {
      flat.set(path, child);
      continue;
    }
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      for (const [nestedKey, nestedValue] of flattenKeys(child, path)) {
        flat.set(nestedKey, nestedValue);
      }
      continue;
    }
    throw new Error(`bad value at ${path}`);
  }
  return flat;
}

/** Returns a sorted list of problems. Empty means the catalogs match. */
export function compareCatalogs(
  catalogs: Readonly<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];
  const flat = new Map<string, Map<string, string>>();
  for (const [locale, value] of Object.entries(catalogs)) {
    try {
      flat.set(locale, flattenKeys(value));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'invalid catalog';
      errors.push(`${locale}: ${message}`);
    }
  }
  const union = new Set<string>();
  for (const map of flat.values()) {
    for (const key of map.keys()) {
      union.add(key);
    }
  }
  const locales = [...flat.keys()];
  for (const key of [...union].sort()) {
    for (const locale of locales) {
      const map = flat.get(locale);
      if (map === undefined || !map.has(key)) {
        errors.push(`${locale} missing ${key}`);
        continue;
      }
      const text = map.get(key) ?? '';
      if (text.trim() === '') {
        errors.push(`${locale} empty ${key}`);
      }
    }
  }
  return errors.sort();
}

export async function checkLocaleFiles(rootDir: string): Promise<string[]> {
  const catalogs: Record<string, unknown> = {};
  for (const locale of LOCALE_FILES) {
    const file = resolve(rootDir, `${locale}.json`);
    catalogs[locale] = JSON.parse(await readFile(file, 'utf8')) as unknown;
  }
  return compareCatalogs(catalogs);
}

const entry = process.argv[1];
const ranAsCli =
  entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;

if (ranAsCli) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = await checkLocaleFiles(rootDir);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
}
