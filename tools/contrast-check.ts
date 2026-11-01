// CI contrast check (docs/08-ux-guidelines.md §2): every documented token pair must meet its
// WCAG 2.2 AA threshold. Run with `pnpm contrast:check` (Node 24 strips the types).
import { readFileSync } from 'node:fs';
import { contrastRatio, tokenPairs } from '@bikri/core';

const tokensCss = readFileSync(
  new URL('../apps/pos/src/styles/tokens.css', import.meta.url),
  'utf8',
).toLowerCase();

let failures = 0;
for (const pair of tokenPairs) {
  const ratio = contrastRatio(pair.fg, pair.bg);
  const inCss =
    tokensCss.includes(pair.fg.toLowerCase()) &&
    tokensCss.includes(pair.bg.toLowerCase());
  const ok = ratio >= pair.needed && inCss;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'pass' : 'FAIL'}  ${ratio.toFixed(2).padStart(5)} ≥ ${pair.needed}  ${pair.name} (${pair.fg} on ${pair.bg})${inCss ? '' : ' [not in tokens.css]'}`,
  );
}
console.log(
  `contrast check: ${failures === 0 ? 'pass' : 'FAIL'} (${tokenPairs.length} pairs)`,
);
process.exit(failures === 0 ? 0 : 1);
