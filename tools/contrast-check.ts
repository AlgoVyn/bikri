// CI contrast check (docs/08-ux-guidelines.md §2): every documented token pair must meet its
// WCAG 2.2 AA threshold. Run with `pnpm contrast:check` (Node 24 strips the types).
import { readFileSync } from 'node:fs';
import { contrastRatio, tokenPairs } from '@bikri/core';

const tokensCss = readFileSync(
  new URL('../apps/pos/src/styles/tokens.css', import.meta.url),
  'utf8',
).toLowerCase();

/** Every declared value of a custom property, including dark aliases. */
const declarations = new Map<string, Set<string>>();
for (const match of tokensCss.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
  const name = match[1] ?? '';
  const value = (match[2] ?? '').trim();
  if (!name) continue;
  const values = declarations.get(name) ?? new Set<string>();
  values.add(value);
  declarations.set(name, values);
}

/** Resolve `var(--other)` aliases so a semantic token's real colour is checked. */
function tokenValues(name: string, seen = new Set<string>()): Set<string> {
  const values = new Set<string>();
  if (seen.has(name)) return values;
  seen.add(name);
  for (const value of declarations.get(`--color-${name}`) ?? []) {
    const alias = /^var\(\s*(--[\w-]+)\s*\)$/u.exec(value);
    if (alias?.[1]) {
      for (const resolved of declarations.get(alias[1]) ?? [])
        values.add(resolved.toLowerCase());
    } else {
      values.add(value);
    }
  }
  return values;
}

/** The semantic tokens a pair documents. @param {{ name: string }} pair */
function pairTokens(pair: { name: string }): { fg: string; bg: string } | null {
  if (pair.name.startsWith('tile '))
    return { fg: 'tile-ink', bg: pair.name.slice('tile '.length).trim() };
  const rest = pair.name.replace(/^(?:light|dark)\s+/u, '');
  const parts = rest.split(' on ');
  const normalise = (name: string) => name.replace(/\s+ink$/u, '-ink');
  /** @param {string} name @param {boolean} isFg */
  const token = (name: string, isFg: boolean) => {
    if (name === 'white') {
      if (!isFg) return 'surface';
      return 'tile-ink';
    }
    return normalise(name);
  };
  if (parts.length === 1) {
    const [name = ''] = parts;
    if (name === 'danger banner')
      return { fg: 'danger-subtle-ink', bg: 'danger-subtle' };
    if (name === 'warning banner')
      return { fg: 'warning-subtle-ink', bg: 'warning-subtle' };
    if (name === 'success banner')
      return { fg: 'success-subtle-ink', bg: 'success-subtle' };
    if (name === 'info banner')
      return { fg: 'info-subtle-ink', bg: 'info-subtle' };
    if (/\s+ink$/u.test(name)) {
      const base = name.replace(/\s+ink$/u, '');
      return {
        fg: base.endsWith('-subtle') ? `${base}-ink` : `${base}-subtle-ink`,
        bg: base.endsWith('-subtle') ? base : `${base}-subtle`,
      };
    }
    if (name.endsWith('-ink'))
      return { fg: name, bg: name.slice(0, -'-ink'.length) };
    return { fg: normalise(name), bg: normalise(name) };
  }
  const [fg = '', bg = ''] = parts;
  return {
    fg:
      fg === 'white'
        ? bg === 'primary' || bg === 'primary-hover'
          ? 'primary-ink'
          : bg === 'danger'
            ? 'danger-ink'
            : 'tile-ink'
        : token(fg, true),
    bg: token(bg, false),
  };
}

let failures = 0;
for (const pair of tokenPairs) {
  const tokens = pairTokens(pair);
  const fgValues = tokens ? tokenValues(tokens.fg) : new Set<string>();
  const bgValues = tokens ? tokenValues(tokens.bg) : new Set<string>();
  const fg = pair.fg.toLowerCase();
  const bg = pair.bg.toLowerCase();
  const fgOk = fgValues.has(fg);
  const bgOk = bgValues.has(bg);
  const inCss = tokens !== null && fgOk && bgOk;
  const ratio = contrastRatio(pair.fg, pair.bg);
  const ok = ratio >= pair.needed && inCss;
  if (!ok) failures += 1;
  const missing = !tokens
    ? ' [unmapped pair]'
    : [
        fgOk ? '' : `--color-${tokens.fg} is not ${pair.fg}`,
        bgOk ? '' : `--color-${tokens.bg} is not ${pair.bg}`,
      ]
        .filter(Boolean)
        .join('; ');
  console.log(
    `${ok ? 'pass' : 'FAIL'}  ${ratio.toFixed(2).padStart(5)} ≥ ${pair.needed}  ${pair.name} (${pair.fg} on ${pair.bg})${missing ? ` [${missing}]` : ''}`,
  );
}
console.log(
  `contrast check: ${failures === 0 ? 'pass' : 'FAIL'} (${tokenPairs.length} pairs)`,
);
process.exit(failures === 0 ? 0 : 1);
