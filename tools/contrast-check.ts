// CI contrast check (docs/08-ux-guidelines.md §2): every documented token pair must meet its
// WCAG 2.2 AA threshold. Run with `pnpm contrast:check` (Node 24 strips the types).
import { contrastRatio, tokenPairs } from '@bikri/core';

let failures = 0;
for (const pair of tokenPairs) {
  const ratio = contrastRatio(pair.fg, pair.bg);
  const ok = ratio >= pair.needed;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'pass' : 'FAIL'}  ${ratio.toFixed(2).padStart(5)} ≥ ${pair.needed}  ${pair.name} (${pair.fg} on ${pair.bg})`,
  );
}
console.log(
  `contrast check: ${failures === 0 ? 'pass' : 'FAIL'} (${tokenPairs.length} pairs)`,
);
process.exit(failures === 0 ? 0 : 1);
