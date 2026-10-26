# 20 — Barcode labels

**Route** `/labels` (modal over the calling screen). Opened from product detail `Print label` (L), product list Select → `Print labels`, and the delivery-saved toast `Print labels` ([13](13-suppliers-and-purchases.md#record-delivery-purchase)). Permission `catalog.edit` or `purchase.create`. v1 prints through the **browser print dialog** (`window.print()`), so any label printer with a Windows/Android driver (e.g. common 2-inch thermal label printers) or a normal printer with A4 sticker sheets works. Direct TSPL/ZPL printing is v2 (T-104).

Many accessories (cables, covers, chargers from local wholesalers) arrive without a barcode; labels let the shop scan everything at the counter.

## Symbology and content

- **Code 128** for every label (dense, any ASCII, read by every USB scanner and by the camera scanner `zxing-wasm`). Encoder: `packages/printer/labels/code128.ts`, own implementation (~150 lines, no dependency):
  - all-digit values of length ≥ 2 → Start C, digit pairs; a trailing odd digit → `Code B` + that digit;
  - anything else → Start B, one symbol per character (ASCII 32–126 only; other characters are rejected with "This barcode has characters a label cannot print");
  - check symbol = (start + Σ position × value) mod 103, then Stop.
  - Test vectors: [fixtures/barcode-code128.json](../fixtures/barcode-code128.json) (symbols, check, module count; each vector was rendered and decoded back with zxing-cpp).
- **Value encoded:** the product's first non-deleted `product_barcodes.barcode`. If the product has none, the dialog offers `Generate barcode` (below); the SKU is not used, because SKUs can be edited and old labels would stop scanning.
- **Text on the label** (top to bottom): shop name (optional, 7 pt, one line), product name `name_en` (8 pt bold, max 2 lines, ellipsis; Urdu name instead when the receipt language is Urdu), price `Rs 1,250` (10 pt bold, optional; `price` at print time — reprint labels after a price change), the bars, and the human-readable value under the bars (7 pt, JetBrains Mono).

### Generated barcodes

`Generate barcode` (product form, label dialog) creates a `product_barcodes` row with a **12-digit in-store code starting with `2`** (`2` + 11 digits from `crypto.getRandomValues`, retried until unique among local non-deleted barcodes). Numbers starting with `2` are reserved for in-store use in the GS1 system, so they never clash with a manufacturer barcode, and all-digit values use the compact Code 128 subset C (121 modules). The server's unique index catches the rare cross-till collision (`UNIQUE_VIOLATION`, [03 §5](../03-sync.md#5-conflict-rules)). A generated barcode is a normal product upsert (no audit row).

## Label sizes (device setting `kv.label`, Settings → Labels)

| Size | Use | Page CSS | Bar height |
|---|---|---|---|
| 50 × 25 mm roll (default) | 2-inch thermal label printer | `@page { size: 50mm 25mm; margin: 0 }`, one label per page | 10 mm |
| 38 × 25 mm roll | small items | `@page { size: 38mm 25mm; margin: 0 }` | 10 mm |
| 40 × 30 mm roll | larger text | `@page { size: 40mm 30mm; margin: 0 }` | 12 mm |
| A4 sheet, 3 × 8 (64 × 33.9 mm) | office printer, sticker sheets | `@page { size: A4; margin: 12.9mm 9mm }`, CSS grid `repeat(3, 64mm)` × rows of `33.9mm` | 12 mm |

Other options: show shop name (default off), show price (default on), printer resolution `203 dpi` (default) / `300 dpi`, A4 **start position** (skip the first n labels of a partly used sheet, 0–23).

**Bar width:** the narrow bar (module) is a whole number of printer dots so thermal printers print even bars: 203 dpi → 3 dots (0.375 mm) if the code fits, else 2 dots (0.25 mm); 300 dpi → 4 dots (0.339 mm) else 3 dots (0.254 mm). "Fits" = `modules_incl_quiet × module ≤ label width − 2 mm` (the 10-module quiet zones are included). If even the narrow module does not fit: error "This barcode is too long for a 38 mm label — use 50 mm or Generate a shorter code". Example: a 12-digit generated code is 121 modules = 45.4 mm at 0.375 mm (fits 50 mm), an 8-character code 143 modules = 35.8 mm at 0.25 mm (fits 38 mm).

**Rendering:** one inline SVG per label with `viewBox` in mm, bars as `<rect>` with `shape-rendering="crispEdges"`, no anti-aliasing; text in HTML. Print CSS hides the app (`body > :not(#label-print-root) { display: none }`), sets `-webkit-print-color-adjust: exact`, `break-after: page` per roll label, and `break-inside: avoid` per A4 cell. The dialog tells the user once: "In the print dialog choose your label printer, Margins: None, Scale: 100%, Headers and footers off".

## Layout

1. List of products to label: thumbnail, name, barcode value (or `Generate barcode` button), copies (`QtyInput`, whole numbers 0–500; default 1 from product screens, the received quantity from a delivery for unit `pc`/`pair`/`set`/`box`/`pack`/`dozen`, 1 for weighed/measured units).
2. Preview of the first label at real size (zoomable) with the size selector.
3. Footer: `Print n labels` (primary, Enter), `Cancel` (Esc). Max 1,000 labels per print job (the browser renders all pages at once).

## States

- Product without barcode and no `catalog.edit`: the row shows "No barcode — ask a manager to generate one", copies disabled.
- Offline: works fully (no server call; a generated barcode syncs later).
- Browser print cancelled: nothing is written; no print history is kept for labels.

## Acceptance criteria

1. `code128.ts` matches every vector in `barcode-code128.json` (symbols, check, module count), and a Playwright test renders each vector's SVG to a PNG and decodes it with `zxing-wasm` to the same value.
2. Printing 3 copies of one product at 50 × 25 mm produces a print document of exactly 3 pages of 50 × 25 mm (Chromium `page.pdf` with `preferCSSPageSize`), each with name, price and a bar code whose narrow bar is 0.375 mm.
3. A4 3 × 8 with start position 5 and 4 labels fills cells 6–9 of the first sheet.
4. `Generate barcode` creates a 12-digit code starting with `2`, unique locally, scannable at the counter (adds the product to the cart).
5. After a delivery of 10 cables and 2 phones, `Print labels` opens with copies 10 and 2.
6. A value with a non-ASCII character is rejected with the message above; a too-long value on 38 mm shows the size error.
7. Manual (H13): labels from the shop's label printer (or A4 sheet) scan with the USB scanner on the first try in 20 of 20 attempts.
