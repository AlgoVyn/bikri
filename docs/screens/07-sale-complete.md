# 07 — Sale complete

Step 2 of the pay modal. Shown after the sale is saved.

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-sale-complete](../reference/dukaan/web-sale-complete.png) | Big tick, change to give, next sale |
| ![Dukaan app-sale-done](../reference/dukaan/app-sale-done.png) | Desktop done screen with print/share |
| ![Dukaan web-receipt-printed](../reference/dukaan/web-receipt-printed.png) | Receipt preview |
| ![Dukaan app-receipt-exported](../reference/dukaan/app-receipt-exported.png) | Exported receipt (Bikri: shop logo at top — REQ-B03; only a small "Powered by AlgoVyn" line at the bottom, D-085) |

## Layout

Centered: success icon, "Sale saved · INV-A-1042", `Change to give Rs 7,000` (very large, only when change > 0), then for udhaar "Rs 3,000 written in Ali's khata · now owes Rs 8,000". Print status line: "Printing…" → "Printed" / "Print failed" with `Retry`. Buttons: `New sale` (primary, Enter / N), `Print again` (P), `Share` (WhatsApp image + text via wa.me, REQ-B04; or Web Share), `Download PDF`, `Open bill` (goes to bill detail).

The receipt preview, Share PNG and PDF use the bundle block from [06 §4.1](../06-printing.md#41-sale-receipt-80-mm-48-columns): one bundle header and the component names/quantities underneath, no component prices. This screen itself shows only the sale total, change and khata amount; the bundle header is never a second total.

The modal auto-closes to an empty Sell screen after 8 s if auto-close is on (Settings → Display; default off), and immediately on any scan (the scanned item starts the next sale).

## Acceptance criteria

1. Scanning a barcode on this screen closes it and adds the item to a new cart.
2. Share produces a PNG receipt image identical to the thermal layout (with logo) and opens `https://wa.me/92300…?text=…` for customers with phones.
3. `Print again` reprints with "REPRINT" under the title.
4. Change amount matches the pay step exactly.
