// CI contrast check (docs/08-ux-guidelines.md §2): every documented token pair must meet its
// WCAG 2.2 AA threshold. Run with `pnpm contrast:check` (Node 24 strips the types).
import { readFileSync } from 'node:fs';
import { contrastRatio } from '@bikri/core';
import { tokenPairs } from '../packages/core/src/tokenPairs.ts';

const tokensCss = readFileSync(
  new URL('../apps/pos/src/styles/tokens.css', import.meta.url),
  'utf8',
).toLowerCase();

/** Brace-matched bodies of every rule whose selector starts with `opener`. */
function blockBodies(css: string, opener: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(opener, from);
    if (at < 0) break;
    const open = css.indexOf('{', at + opener.length);
    if (open < 0) break;
    let depth = 0;
    let end = -1;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      else if (css[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) break;
    bodies.push(css.slice(open + 1, end));
    from = end + 1;
  }
  return bodies;
}

function declarationsIn(bodies: string[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const body of bodies)
    for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
      const name = match[1] ?? '';
      const value = (match[2] ?? '').trim();
      if (!name) continue;
      const values = map.get(name) ?? new Set<string>();
      values.add(value);
      map.set(name, values);
    }
  return map;
}

// Light values live in @theme; both dark selectors alias the --dark-* values declared in
// the base :root. Keeping the scopes apart stops a dark value from satisfying a light pair
// (and vice versa), which the previous flat map allowed.
const light = declarationsIn(blockBodies(tokensCss, '@theme'));
const base = declarationsIn(blockBodies(tokensCss, ':root {'));
const darkSelector = declarationsIn(
  blockBodies(tokensCss, '[data-theme="dark"]'),
);
const darkMedia = declarationsIn(
  blockBodies(tokensCss, ':root:not([data-theme="light"])'),
);

/** Resolve `var(--other)` aliases inside a theme so a token's real colour is checked. */
function resolveVariable(
  theme: 'light' | 'dark',
  variable: string,
  seen: Set<string> = new Set(),
): Set<string> {
  const scopes = theme === 'dark' ? [darkSelector, base] : [light, base];
  const values = new Set<string>();
  if (seen.has(variable)) return values;
  const nextSeen = new Set(seen).add(variable);
  for (const scope of scopes) {
    for (const value of scope.get(variable) ?? []) {
      const alias = /^var\(\s*(--[\w-]+)\s*\)$/u.exec(value);
      if (alias?.[1]) {
        for (const resolved of resolveVariable(theme, alias[1], nextSeen))
          values.add(resolved);
      } else {
        values.add(value);
      }
    }
  }
  return values;
}

function tokenValues(theme: 'light' | 'dark', name: string): Set<string> {
  return resolveVariable(theme, `--color-${name}`);
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
// The two dark selectors must stay identical: a colour added to one but not the other
// silently changes the theme for users who never picked it.
for (const name of new Set([...darkSelector.keys(), ...darkMedia.keys()])) {
  const selector = [...(darkSelector.get(name) ?? [])].sort().join('|');
  const media = [...(darkMedia.get(name) ?? [])].sort().join('|');
  if (selector === media) continue;
  failures += 1;
  console.log(`FAIL  dark selector drift: ${name} (${selector} vs ${media})`);
}
for (const pair of tokenPairs) {
  const theme = pair.name.startsWith('dark ') ? 'dark' : 'light';
  const tokens = pairTokens(pair);
  const fgValues = tokens ? tokenValues(theme, tokens.fg) : new Set<string>();
  const bgValues = tokens ? tokenValues(theme, tokens.bg) : new Set<string>();
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
