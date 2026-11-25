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

const LRI = '\u2066';
const PDI = '\u2069';

/**
 * A number range or `W × H` dimension. U+2013 and U+00D7 are bidi-neutral, so in an
 * RTL paragraph "3–30" renders as "30–3" unless it sits inside an LRI…PDI isolate
 * (CORE-M5). Urdu digits are included because catalogs may use them.
 */
const URDU_RANGE =
  /(?:[\d\u0660-\u0669\u06F0-\u06F9]+|\{\{[^{}]+\}\})\s*[–×-]\s*(?:[\d\u0660-\u0669\u06F0-\u06F9]+|\{\{[^{}]+\}\})/gu;

function isolated(text: string, start: number, end: number): boolean {
  let depth = 0;
  for (let i = 0; i < start; i += 1) {
    if (text[i] === LRI) depth += 1;
    else if (text[i] === PDI && depth > 0) depth -= 1;
  }
  if (depth === 0) return false;
  for (let i = end; i < text.length; i += 1) {
    if (text[i] === LRI) depth += 1;
    else if (text[i] === PDI) {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

/** Keys in a `ur` catalog with a numeric range outside a U+2066…U+2069 isolate. */
export function unisolatedNumericRanges(value: unknown): string[] {
  const found = new Set<string>();
  for (const [key, text] of flattenKeys(value)) {
    for (const match of text.matchAll(URDU_RANGE)) {
      if (
        !isolated(text, match.index ?? 0, (match.index ?? 0) + match[0].length)
      )
        found.add(key);
    }
  }
  return [...found].sort();
}

/**
 * Areas are merged into the active language's single `translation` namespace
 * (`areas.tsx`), so a root key and an area key must never flatten to the same path.
 */
export function crossAreaDuplicates(
  catalogs: Readonly<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];
  const owners = new Map<string, string>();
  for (const [area, value] of Object.entries(catalogs)) {
    let flat: Map<string, string>;
    try {
      flat = flattenKeys(value);
    } catch {
      continue; // compareCatalogs already reports the malformed catalog.
    }
    for (const key of flat.keys()) {
      const owner = owners.get(key);
      if (owner === undefined) owners.set(key, area);
      else errors.push(`duplicate key ${key} in ${owner} and ${area}`);
    }
  }
  return errors.sort();
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
  const reference = flat.get('en');
  const placeholders = (text: string) => {
    const matches = [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/gu)];
    if (/[{}]/u.test(text.replace(/\{\{\s*[\w.]+\s*\}\}/gu, ''))) {
      return 'malformed-braces';
    }
    return matches
      .map((match) => match[1])
      .sort()
      .join(',');
  };
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
      const got = placeholders(text);
      if (got === 'malformed-braces') {
        errors.push(`${locale} malformed placeholders ${key}`);
        continue;
      }
      if (reference !== undefined && locale !== 'en') {
        const expected = placeholders(reference.get(key) ?? '');
        // The `en` iteration already reports a malformed reference key once.
        if (expected === 'malformed-braces') continue;
        if (got !== expected)
          errors.push(`${locale} placeholders differ ${key}`);
      }
    }
  }
  return errors.sort();
}

export async function checkLocaleFiles(rootDir: string): Promise<string[]> {
  const errors: string[] = [];
  const perLocale = new Map<string, Record<string, unknown>>();
  for (const locale of LOCALE_FILES) perLocale.set(locale, {});
  // The app catalogs and the operator console's own catalogs (D-112) are checked separately.
  for (const [dir, label] of [
    [rootDir, ''],
    [resolve(rootDir, 'admin'), 'admin/'],
    [resolve(rootDir, 'office'), 'office/'],
    [resolve(rootDir, 'public'), 'public/'],
  ] as const) {
    const area = label === '' ? 'root' : label.slice(0, -1);
    const catalogs: Record<string, unknown> = {};
    for (const locale of LOCALE_FILES) {
      const file = resolve(dir, `${locale}.json`);
      const text = await readFile(file, 'utf8');
      for (const duplicate of duplicateJsonKeys(text)) {
        errors.push(`${label}${locale}: duplicate key ${duplicate}`);
      }
      const parsed: unknown = JSON.parse(text);
      catalogs[locale] = parsed;
      const bucket = perLocale.get(locale);
      if (bucket !== undefined) bucket[area] = parsed;
    }
    errors.push(...compareCatalogs(catalogs).map((e) => `${label}${e}`));
    if (catalogs.ur !== undefined) {
      errors.push(
        ...unisolatedNumericRanges(catalogs.ur).map(
          (key) => `${label}ur: unisolated numeric range ${key}`,
        ),
      );
    }
  }
  for (const locale of LOCALE_FILES) {
    const areas = perLocale.get(locale);
    if (areas === undefined) continue;
    errors.push(...crossAreaDuplicates(areas).map((e) => `${locale}: ${e}`));
  }
  return errors.sort();
}

/**
 * Finds duplicate object keys in raw JSON. `JSON.parse` keeps only the last one, so a
 * duplicated translation silently disappears from the catalog otherwise.
 */
export function duplicateJsonKeys(text: string): string[] {
  const duplicates: string[] = [];
  const stack: Array<Set<string> | null> = [];
  let inString = false;
  let escaped = false;
  let token = '';
  const checkKey = (value: string, end: number): void => {
    let at = end;
    while (at < text.length && /\s/u.test(text[at] ?? '')) at += 1;
    if (text[at] !== ':') return;
    const keys = stack.at(-1);
    if (!keys) return;
    if (keys.has(value)) duplicates.push(value);
    else keys.add(value);
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (inString) {
      if (escaped) {
        escaped = false;
        token += ch;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        checkKey(token, i + 1);
      } else {
        token += ch;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      token = '';
    } else if (ch === '{') {
      stack.push(new Set<string>());
    } else if (ch === '[') {
      stack.push(null);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    }
  }
  return duplicates;
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
