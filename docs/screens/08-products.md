# 08 — Products

**Routes** `/products` (list), `/products/:id` (detail), `/products/new`, `/products/:id/edit`, `/products/import`, `/products/categories`, `/products/price-update`. View: everyone; edit: `catalog.edit`; delete: `catalog.delete`; cost/margin/profit: `cost.view`.

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-products](../reference/dukaan/web-products.png) | List with stock and price columns |
| ![Dukaan app-products-menu](../reference/dukaan/app-products-menu.png) | "More" menu: Select, Add from suggested list, Update prices, Manage categories, Stock overview, Expiry, Import spreadsheet |
| ![Dukaan app-categories-empty](../reference/dukaan/app-categories-empty.png) | Categories empty state |
| ![Dukaan web-product-detail](../reference/dukaan/web-product-detail.png) | Detail: price, cost, stock |
| ![Dukaan app-product-detail-usbc](../reference/dukaan/app-product-detail-usbc.png) | Detail: profit/margin, 14-day sales, stock history |
| ![Dukaan app-product-detail-earbuds](../reference/dukaan/app-product-detail-earbuds.png) | Detail for another product |
| ![Dukaan app-setup-4-first-product](../reference/dukaan/app-setup-4-first-product.png) | Product form fields |

Bikri differences: photos (REQ-B10), weighted-average cost shown next to last cost (REQ-B11), CSV export of the list (REQ-B02), barcode labels from the browser ([screens/20](20-barcode-labels.md)), no "Batches & expiry" in v1 (v2).

**One product per variant (v1):** every sellable variant is its own product with its own SKU, barcode(s), price and stock, e.g. "Type-C cable 1 m white" and "Type-C cable 1 m black". There is no variant/option model in v1 (deferred to v2, T-110). To make this quick, product detail has `Duplicate` (copies every field except SKU, barcodes, photo and stock, opens the form with the name selected) and the list search matches every word, so "cable white" finds the variant.

## Product list

Layout: page header with a Products icon, title, subtitle and a primary `+ Add product` (N) plus a `More` kebab menu (Select, Export CSV, Import, Update prices, Manage categories, Add from suggested list, Stock count). The filter toolbar and the table each sit in a card. Table (desktop) / cards (mobile) columns: photo 40 px, Name (+ brand, SKU small), Category, Price, Stock (with unit; amber ≤ min, red ≤ 0), Avg cost and Margin % (only `cost.view`), 30-day sold. Virtualised; 5,000 products scroll at 60 fps.

Select mode: checkboxes; bulk actions `Change category`, `Update prices`, `Print labels` ([screens/20](20-barcode-labels.md)), `Delete` (owner), `Export selected`.

## Product detail

Header: photo (click → full view / replace), name (+ Urdu name), brand, category, SKU, barcodes. Action buttons: `Edit` (E), `Adjust stock` (A, → [09](09-stock-adjust.md)), `Print label` (L, → [20](20-barcode-labels.md)), `Duplicate` (variant helper), `Sell` (adds to current cart), `Delete`.

Cards:
1. **Price** Rs 1,499 · **Avg cost** Rs 1,120 · **Last cost** Rs 1,200 · **Profit per item** Rs 379 · **Margin** 25.3% (margin = (price − avg)/price; cost cards only with `cost.view`).
2. **Stock**: on hand (derived from `stock_movements`), min stock, stock value (`cost.view`).
3. **Last 14 days**: bar chart of qty sold per day (local data), total sold, revenue.
4. **Stock history**: list of movements newest first — date/time, reason (localised), ± qty, balance after, by whom, link to bill/delivery. Export CSV.

## Add / edit product

Single page form (sheet on mobile). Sections:

| Field | Type | Rules / default |
|---|---|---|
| Photo | camera capture (`capture="environment"`) or file; crop square | WebP 512×512 q=0.8, ≤ 150 KB; stored local first, uploaded via `file_queue` to `PUT /api/files/product_image/:id/:sha256` |
| Name (English) | text | required 1–80; duplicate name warning (not blocking) |
| Name (Urdu) | text, `dir=rtl` | optional 0–80; used on Urdu receipts |
| Category | select + `+ New` | optional |
| Brand | text with suggestions from existing brands | optional 0–40 |
| Barcode(s) | text + `Scan` (camera) + `+ Add another` + `Generate` | unique across active products → "Already used by {name}" (blocking). `Generate` creates an in-store code (12 digits starting with `2`, [screens/20](20-barcode-labels.md#generated-barcodes)) for items that came without a barcode |
| SKU | text + `Generate` | if blank, generated (02 rule); unique |
| Sale price | `MoneyInput` | required ≥ 0; 0 asks "Sell for free?" confirm |
| Cost price | `MoneyInput` | `cost.view` only; on create becomes opening `unit_cost` |
| Opening stock | `QtyInput` | create only; writes `stock_movements` `opening` with unit cost; later changes go through Adjust stock |
| Unit | select pc, pair, set, box, pack, dozen, m, kg, g, l, ml | default pc |
| Track stock | switch | default on; off hides stock fields (services, quick items) |
| Low stock alert at | `QtyInput` | default 0 = off → `min_stock_milli` |
| Warranty | select None / 7 days / 1 month / 3 / 6 / 12 months / custom days | printed on receipt line "Warranty till 26-04-2027" when > 0 |
| Notes | textarea 0–500 | |

Footer: `Save` (Ctrl+S), `Save and add another` (Ctrl+Shift+S), `Cancel` (Esc, confirm when dirty). Price or cost change writes `audit_log` `price_change` / `cost_change`. Editing cost on an existing product does **not** change avg cost history; it sets `last_cost` only (owner warning: "Use a delivery to record new stock at a new cost").

Delete: only if not referenced by an unsynced op; soft delete (`deleted_at`), product disappears from Sell, history remains. `audit_log product_delete`.

## Import spreadsheet

Accepts `.csv` (papaparse) and `.xlsx` (read-excel-file), ≤ 5,000 rows. Steps: 1) choose file / download template (`bikri-products-template.csv` with columns `name_en,name_ur,category,brand,barcode,sku,price,cost,stock,unit,min_stock,track_stock`), 2) map columns (auto-match header names in English/Roman Urdu), 3) preview with row-level errors (red cell + message) and summary "980 new, 15 updates (matched by SKU or barcode), 5 errors", 4) import — written in chunks of 50 rows per Dexie transaction (≤ 200 sync ops each, [03 §3](../03-sync.md#3-outbox)); progress bar; rows with errors are skipped and downloadable as `import-errors.csv`. Prices given in rupees (decimals allowed) are converted to paisa. Each non-empty `barcode` cell (several allowed, separated by `;`) becomes a `product_barcodes` row. The `stock` and `cost` columns create an `opening` movement **only for new products**; for matched (updated) products they are ignored and the preview says so (use a stock count to correct stock).

## Update prices (bulk)

Filter by category/brand/selection → change by `+/− %` or `+/− Rs` or `set to` → rounding (none / Rs 1 / Rs 5 / Rs 10) → preview old → new → apply (one upsert per product; `audit_log price_change` per product; chunks of 100 products per transaction).

## Categories

List with drag to reorder (`sort_order`), rename, colour (the 8 Algovyn-based tile swatches from [08 §2](../08-ux-guidelines.md#colour-light--dark--algovyn-brand-decision-d-025)), delete (only when no active products; else "Move 12 products first"). Empty state: "No categories yet — add Chargers, Cables, Earbuds…".

## Acceptance criteria

1. Creating a product with cost Rs 1,100 and opening stock 20 gives on hand 20, avg cost 110000, last cost 110000.
2. Duplicate barcode is blocked with the other product's name.
3. A photo taken offline shows on the Sell tile immediately and uploads after reconnecting; a second till shows it after sync.
4. Cashier sees no cost, margin or profit anywhere on these screens and no cost column in CSV export.
5. Importing the template with 1,000 valid rows finishes in < 10 s and creates 1,000 opening movements.
6. Bulk +10% with Rs 10 rounding turns Rs 1,499 into Rs 1,650.
7. `Duplicate` on "Type-C cable 1 m white" opens a new product with the same category, brand, price, cost, unit and warranty, and empty SKU, barcodes, photo and opening stock; saving creates a separate product.
7. Stock history balance-after column matches on hand after the latest row.
