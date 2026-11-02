#!/usr/bin/env node
/** Check that literal `t('…')` keys used by the till exist in the English catalogs. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'apps/pos/src');
const CATALOGS = [
  'packages/i18n/en.json',
  'packages/i18n/office/en.json',
  'packages/i18n/admin/en.json',
];
const PLURAL = ['_zero', '_one', '_two', '_few', '_many', '_other'];

function flatten(value, prefix = '', out = new Set()) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.add(prefix);
    return out;
  }
  for (const [key, child] of Object.entries(value))
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

const keys = new Set();
for (const file of CATALOGS) {
  const parsed = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  for (const key of flatten(parsed)) keys.add(key);
}

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    if (statSync(file).isDirectory()) walk(file);
    else if (
      /\.(ts|tsx)$/u.test(entry) &&
      !entry.includes('.test.') &&
      !entry.endsWith('.d.ts')
    )
      files.push(file);
  }
}
walk(SOURCE);

const missing = [];
const literal = /\bt\(\s*(['"])((?:\\.|(?!\1).)+)\1/g;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(literal)) {
    const key = match[2];
    if (key.includes('${')) continue;
    if (keys.has(key) || PLURAL.some((suffix) => keys.has(`${key}${suffix}`)))
      continue;
    missing.push(`${relative(ROOT, file)}: ${key}`);
  }
}
if (missing.length > 0) {
  console.error(`i18n key usage: ${missing.length} missing key(s)`);
  for (const line of missing) console.error(`  ${line}`);
  process.exit(1);
}
console.log('i18n key usage: pass');
