# Design review checklist

Run this on every PR that adds or changes a screen. A **no** is a blocker unless the PR says why and a decision records it.

1. **One primary action.** Is there exactly one filled primary button, and is it the next action? Are destructive actions outlined and behind a confirm?
2. **One surface per job.** Is the toolbar, summary and row list inside one surface (or a flat context strip), rather than three stacked cards?
3. **The frame holds.** Does the page use `pageClass()` (`focused`, `standard`, `wide` or `workspace`) and does the header align with the content at 1280?
4. **Numbers are sacred.** Is every amount right-aligned, tabular, never truncated, and in Inter (mono only for invoice numbers, SKUs and barcodes)?
5. **Red means one thing.** Is red used only for destructive, error, overdue or below-cost states — not normal debt or a missing printer?
6. **Every state exists.** Empty, loading, offline, read-only, error, permission-denied and no-match each look intentional and offer the next action.
7. **Urdu is first-class.** Does the screen work at 390 and 1280 in `ur` with no clipped names, pills or money, and are numbers still Western digits inside `<bdi>`?
8. **Touch and keyboard.** Are targets at least 44×44 px, focus visible, dialogs trapped and Esc-closable, and the screen's hotkeys working?
9. **Motion is quiet.** Do hover/press/overlay transitions use the shared 140/200 ms values and respect reduced motion?
10. **The four widths pass.** At 390, 768, 1280 and 1920 there is no horizontal scroll, no overlap and no money clipped; the top bar still fits.

Also run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm i18n:check`, `pnpm contrast:check` and the axe sweep before merging.

`e2e/tests/layout.spec.ts` enforces the four-width and Urdu invariants. To attach the full screenshot matrix (390/768/1280/1920) to the Playwright report for a manual review, run:

```sh
VISUAL=1 pnpm --filter @bikri/e2e exec playwright test tests/layout.spec.ts --project=desktop --reporter=html
```
