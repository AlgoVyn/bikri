# 18 — Price check

Modal from Home / rail / hotkey `Alt+P`. Everyone. Customers often ask "how much is this?" without buying.

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan app-home](../reference/dukaan/app-home.png) | "Price check" is a Home quick action |

## Layout

Large search/scan field (autofocus). Result card: photo, name (English + Urdu), price (very large), stock ("12 in stock" / "Out of stock" / hidden if not tracked), other barcodes; with `cost.view`: avg cost and margin small. Buttons `Add to cart` (Enter; adds to the active Sell cart), `Scan another` (clears), `Close` (Esc). Unknown barcode: "Not found" + `Add product` (with `catalog.edit`).

## Acceptance criteria

1. Scanning shows the card in < 100 ms after the Enter suffix.
2. Nothing is written; no audit.
3. Cashier never sees cost.
