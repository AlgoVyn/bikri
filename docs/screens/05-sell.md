# 05 — Sell

**Route** `/sell`. Permission `sale.create`. The most used screen: optimise for keyboard + barcode scanner on desktop and thumbs on phones. Performance budgets: [08 §7](../08-ux-guidelines.md#7-performance-budgets).

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-sell-empty](../reference/dukaan/web-sell-empty.png) | Empty cart, search focus, product grid |
| ![Dukaan web-sell-cart-line-discount](../reference/dukaan/web-sell-cart-line-discount.png) | Line discount Rs/% inline on a cart line |
| ![Dukaan app-sell-cart-discounts](../reference/dukaan/app-sell-cart-discounts.png) | Line + bill discount, totals block (Subtotal / Item discounts / Discount / Total to pay), Customer 1/2/3 tabs, Held bills, Quick sale |

Bikri differences: product photos on tiles (REQ-B10), "Below cost" flag (REQ-B14), no lag on input (REQ-B07), stock warning never blocks (REQ-C07).

## Layout (≥ 1024 px: two columns; < 1024 px: product area full screen with a sticky cart bar that expands into a sheet)

**Start column (≈ 60%) — find products**
1. Search box (autofocus; placeholder "Search or scan — name, barcode, SKU"; KeyBadge F2). Results replace the grid as you type.
2. Category chips row (All, then categories by sort order, horizontally scrollable).
3. Product grid: tiles 132×132 px min — photo (or coloured initials if none), name (2 lines max), price, stock pill ("12 left", amber when ≤ `min_stock_milli`, red "Out" when ≤ 0, hidden if `track_stock = 0`). Sorted by: selling frequency over 30 days on this device, then name. Virtualised.
4. Below the grid on desktop: `Quick sale` (F7) and `Held bills (n)` (F6) buttons.

**End column (≈ 40%) — cart**
1. Cart tabs: `Customer 1`, `Customer 2`, `Customer 3` (Ctrl+1/2/3); a dot marks non-empty carts. Each tab is an independent cart persisted in Dexie `carts` (survives reload and lock).
2. Customer row: "Walk-in customer" or chosen customer name + balance ("Owes Rs 5,890"), `Change` button (search customers by name/phone, `+ New customer`). Choosing a customer is optional except for udhaar.
3. Cart lines (newest on top, configurable): name, unit price, `QtyInput`, line total; expand chevron (or click line) reveals: unit price override (needs `catalog.edit` or override if lower than price), discount with `Rs | %` toggle, note (e.g. serial no / IMEI, 0–60 chars), remove. Badges on line: `−Rs 200` discount, `Below cost` (red), `Not enough stock` (amber, informational).
4. Totals block (exact labels): `Subtotal (n items)` = Σ gross, `Item discounts` (−, hidden if 0), `Discount` with an `Add discount` link (F3) opening Rs/% input (hidden if 0 until added), `Sales tax 17%` (only if tax > 0 and `tax_mode = exclusive`), `Rounding` (only if ≠ 0), **`Total to pay`** (large); with `tax_mode = inclusive` a small muted line under the total: `Includes Sales tax 17%: Rs 1,700`. Figures from [07 §3](../07-money-rules.md#3-bill-totals).
5. Actions row: `Hold` (Ctrl+H / F4), `Clear` (Esc, confirm if > 0 lines), **`Take payment`** (Enter / F8, primary, full width, shows total).

## Adding items

| Input | Result |
|---|---|
| Scan barcode matching a non-deleted `product_barcodes.barcode` (or a product `sku`) | Adds 1 (or increments the existing line); beep (WebAudio, 60 ms) |
| Scan unknown barcode | Toast "No product with barcode 8964000…" with `Add product` (prefills barcode; needs `catalog.edit`) and `Quick sale` |
| Type + Enter with exactly 1 result | Adds it |
| Type + ↓/↑ + Enter | Adds highlighted result |
| `*` then number in search (e.g. `3*` before scan) | Sets quantity for the next add |
| Tap tile | Adds 1 |
| Quick sale (F7) | Dialog: description (default "Item"), price (`MoneyInput`, required > 0), qty; adds a line with `product_id = null`, no stock movement, cost 0 |

Same product added twice merges into one line unless the line has a note or a price override.

## Validation and warnings (never block unless stated)

| Rule | UX |
|---|---|
| Qty > on hand (track_stock) | amber badge "Only 2 in stock" — sale allowed (REQ-C07) |
| Line below cost (07 §3.2) | red badge "Below cost!"; Take payment requires `sale.below_cost` or override |
| Total discount > staff limit | Take payment opens override (07 §3.1) |
| Price override below sale price | requires `catalog.edit` or override |
| Line discount > gross | capped, field shows red border with "Max Rs 500" |
| Empty cart | Take payment disabled |
| 60 lines in the cart | adding another line is blocked: "A bill can have 60 lines — take payment and start a second bill" (keeps one bill's sync ops ≤ 200, [03 §3](../03-sync.md#3-outbox)) |
| Quantity 0 | line removed |

Cost and margin are never shown here, except a small "Cost Rs 1,120 · margin 12%" in the expanded line for users with `cost.view` when `shop.show_cost_on_till = 1`.

## Held bills (F6)

Hold (Ctrl+H) moves the active cart into `held_bills` with an optional label (default: customer name or "Held 10:42") and clears the tab. Held bills panel lists label, time, item count, total, staff; `Resume` (into the active tab if empty, else asks which tab), `Delete` (confirm). Held bills are local to the device and expire after 7 days (warning on Home).

## States

- No products: empty state "No products yet" + `Add product` and `Quick sale`.
- Search no results: "Nothing matches 'xyz'" + `Quick sale "xyz"`.
- Offline: no change (fully local), sync badge shows waiting count.
- Device not set to a branch: blocked with "Ask the owner to assign this device to a branch".

## Hotkeys

`F2`/`Ctrl+F` search, `Ctrl+1–3` cart tabs, `↑/↓` move in results or lines, `+`/`-` change qty of the selected line, `Delete` remove selected line, `F3` bill discount, `Ctrl+H`/`F4` hold, `F6` held bills, `F7` quick sale, `Enter`/`F8` take payment (when search is empty), `F9` open drawer (`drawer.open`), `Esc` clear search → collapse line → clear cart (confirm), `N` new sale (clears current tab after confirm when not focused in an input).

## Acceptance criteria

1. Scanning the same barcode 3 times gives one line with qty 3 and beeps 3 times.
2. With 1,000 products, keystroke-to-results paint < 50 ms on the reference PC (REQ-B07; Playwright perf trace).
3. Cart from vector T2 ([07 §3.3](../07-money-rules.md#33-totals-test-vectors)) shows: Subtotal (2 items) Rs 45,500 · Item discounts −Rs 2,000 · Discount −Rs 500 · Total to pay Rs 43,000.
4. A line priced Rs 900 with avg cost Rs 1,000 shows "Below cost!" for a cashier, and Take payment opens the manager override.
5. Three carts can be filled independently; reload keeps all three.
6. Hold, then resume on the same device restores lines, discounts and customer exactly.
7. Selling more than stock shows the amber badge and completes the sale; stock goes negative.
8. Quick sale "Repair labour Rs 500" completes with no stock movement.
9. RTL: in Urdu, cart is on the left, grid on the right, numbers remain LTR.
