# 08 — Products

**Routes** `/products` (list), `/products/:id` (detail), `/products/new`, `/products/:id/edit`, `/products/import`, `/products/categories`, `/products/price-update`. View: everyone; edit: `catalog.edit`; delete: `catalog.delete`; cost/margin/profit: `cost.view`. On ≥ 1280 px the list and the selected product share one master–detail screen ("Select a product" until one is picked); the embedded list shows name, price and stock, while the detail keeps every column and action. Below 1280 px the detail is a full page. At every width the detail header starts with the shared circular back button and a 40 px product photo beside the name (the same header rhythm as Sales, Udhaar and Suppliers); the back button clears the selection.

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

Layout: page header with a Products icon, title, subtitle and a primary `+ Add product` (N) plus a `More` kebab menu (Select, Export CSV, Import, Update prices, Manage categories, Add from suggested list, Stock count). The filter toolbar and the table each sit in a card. Table (desktop) / cards (mobile) columns: photo 40 px, Name (+ brand, SKU small), Category, Price, Stock (with unit; amber ≤ min, red ≤ 0), Avg cost and Margin % (only `cost.view`), 30-day sold. Every column header sorts: the first click uses the column's natural order (A–Z, low to high, or best sellers first for Sold) and clicking the active header again reverses it; the arrow shows the current direction. On phones, where the header row is hidden, the sort select and the direction button in the filter toolbar do the same. Virtualised; 5,000 products scroll at 60 fps.

Select mode: checkboxes; bulk actions `Change category`, `Update prices`, `Print labels` ([screens/20](20-barcode-labels.md)), `Delete` (owner), `Export selected`.

## Product detail

Header: photo (click → full view / replace), name (+ Urdu name), brand, category, SKU, barcodes. Action buttons: `Edit` (E), `Adjust stock` (A, → [09](09-stock-adjust.md)), `Print label` (L, → [20](20-barcode-labels.md)), `Duplicate` (variant helper), `Sell` (adds to current cart), `Delete`.

Cards:
1. **Price** Rs 1,499 · **Avg cost** Rs 1,120 · **Last cost** Rs 1,200 · **Profit per item** Rs 379 · **Margin** 25.3% (margin = (price − avg)/price; cost cards only with `cost.view`).
2. **Stock**: on hand (derived from `stock_movements`), min stock, stock value (`cost.view`).
3. **Last 14 days**: bar chart of qty sold per day (local data), total sold, revenue.
4. **Stock history**: list of movements and stock-tracking changes newest first — date/time, reason (localised), ± qty (`—` for a tracking change), balance after, by whom, link to bill/delivery. A tracking change row also shows the low-stock alert before → after when it changed. The screen renders the newest 200 movements plus any tracking changes in that time window and appends older rows with `Show older`; Export CSV still writes the product's full history (tracking rows use `track_stock_off` / `track_stock_on`).

## Bundles (v1.1)

A **bundle** is a product row with `products.kind='bundle'`, `track_stock=0`, a bundle price and a fixed recipe of real component products. It reuses the product row so barcodes, search, photos, categories, labels and price check work unchanged; the recipe is `bundle_items` ([02 §2.16](../02-data-model.md#216-bundles-migration-0017_bundlessql)). The cashier cannot substitute components; the owner edits the recipe here.

The English UI label is **Bundle**; Roman Urdu uses **Bundle**. The Urdu label is a translation choice between **بنڈل**, **سیٹ** and **پیکج** (native-speaker review). Do not use "combo" in UI strings or identifiers.

**Product list**
- The existing filter toolbar gains a `Bundles` filter (All / Bundles / categories) and rows show a small neutral `Bundle` pill next to the name.
- The stock column shows derived availability (`min(floor(component on_hand / per-bundle qty))`) as "3 bundles" rather than a stock quantity; untracked components are ignored. If every component is untracked, show "Made to order" instead of a number.
- Avg cost and margin are derived from the recipe for `cost.view`; the 30-day sold figure sums each bundle group's `bundle_qty`, not component lines.
- Select mode may include bundles for category changes, labels and delete, but **not** for Update prices in v1.1.

**Product detail**
- Header: photo/monogram, name, `Bundle` pill, category/SKU/barcodes. Actions: `Edit`, `Print label`, `Sell`, `Duplicate`, `Delete`; no `Adjust stock` and no stock-adjust shortcut.
- Price and Margin cards use the derived figures. The three-figure row shows **Avg cost**, **Items total** (sum of component shelf prices) and **Available** (bundles). Price card hint: "Customer saves Rs X vs items" (can be negative when the bundle costs more).
- `Last 14 days` shows bundles sold (the sum of each group's `bundle_qty`) and bundle revenue; returns subtract whole bundles on the refund's business date.
- `Items in this bundle` card: component name, SKU, `1 per bundle` (or the recipe quantity), component price and component stock; a muted note "Stock is deducted from each item when the bundle is sold. The bundle itself has no stock."
- No Stock history card for the bundle itself; the recipe card replaces it. Component stock history is available from each component product.

**Add / edit bundle**
- The normal product form is reused with these differences:
  - Hide `Cost price`, `Opening stock`, `Track stock`, `Low stock alert` and `Warranty` for a bundle; force `track_stock=0` and unit `set` (or another whole-unit type). Show the derived cost/margin/availability instead.
  - `Bundle price` is the normal `Sale price`; required ≥ 0.
  - **Items in this bundle** editor: product search/scan (simple products only), `QtyInput` per bundle, drag/sort and remove; `+ Add item`. At least 1 and at most 20 components; duplicate components merge; no self-reference and no nested bundle; do not allow deleted components.
  - Live summary: items total, customer saves, derived margin (with `cost.view`), availability and the limiting component.
  - Save writes the changed product row (create, price or name) and the `bundle_items` upserts/soft deletes in one action; audit `bundle_change` with the recipe before/after; a price change also writes `price_change`. No stock movement is written.
- Delete: soft-delete the product; existing sales, receipts and held-bill snapshots are unchanged. A product used by an active bundle cannot be deleted or changed to `kind='bundle'` until the recipe is removed. `Duplicate` copies the recipe, with new item ids and no SKU/barcodes/photo/stock.

**Import, bulk price, labels, search, purchases and stock**
- The normal spreadsheet import and bulk price update **exclude bundles** in v1.1. The product CSV export adds a `kind` column (`simple`/`bundle`) and includes bundle rows; it does not include the recipe. The normal import skips bundle rows with a row error ("bundles are managed on the bundle screen") until a dedicated bundle import/export (a `bundle_items` sheet) exists. The server export/backup still includes the table.
- Purchases and supplier returns use the component products only; a bundle product is excluded from their product picker (buy the components). Stock count/adjust also lists components only; the bundle is never counted or adjusted as a unit.
- A bundle barcode can be printed from the normal label screen; scanning it on Sell adds the bundle. Price check shows the bundle price and a compact contents list. Global search finds the bundle by its own name/SKU/barcode; searching a component name does not add the bundle.

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
| Cost price | `MoneyInput` | `cost.view` only; on create becomes opening `unit_cost`. After create it is editable only while the product is untracked; a tracked product takes its cost from deliveries and stock movements |
| Opening stock | `QtyInput` | create only; writes `stock_movements` `opening` with unit cost; later changes go through Adjust stock |
| Unit | select pc, pair, set, box, pack, dozen, m, kg, g, l, ml | default pc |
| Track stock | switch | default on; off hides stock fields (services, quick items). Turning it off on a product that had it on shows an inline warning and asks for confirmation before saving: the current stock and history stay, sales/deliveries stop changing it and the low-stock alert is cleared. Cancelling the confirmation (or pressing Esc) puts the switch back on |
| Low stock alert at | `QtyInput` | default 0 = off → `min_stock_milli` |
| Warranty | select None / 7 days / 1 month / 3 / 6 / 12 months / custom days | printed on receipt line "Warranty till 26-04-2027" when > 0 |
| Notes | textarea 0–500 | |

Header: the back arrow returns to this product's detail when editing or duplicating, and to the product list when adding; leaving with unsaved changes asks before discarding. Footer: `Save` (Ctrl+S), `Save and add another` (Ctrl+Shift+S), `Cancel` (Esc, confirm when dirty). Price change and an untracked product’s cost change write `audit_log` `price_change` / `cost_change`. A tracked product’s cost field is disabled on edit; turn tracking off first to edit it. Turning tracking on or off writes `audit_log` `track_stock_change` (with the old/new low-stock alert when it changes); it never writes a stock movement, so existing stock stays but is frozen while untracked. Editing cost on an existing untracked product does **not** change avg cost history; it sets `last_cost` only (owner warning: "Use a delivery to record new stock at a new cost").

Delete: only if not referenced by an unsynced op; soft delete (`deleted_at`), product disappears from Sell, history remains. `audit_log product_delete`.

## Import spreadsheet

Accepts `.csv` (papaparse) and `.xlsx` (read-excel-file), ≤ 5,000 rows. Steps: 1) choose file / download template (`bikri-products-template.csv` with columns `name_en,name_ur,category,brand,barcode,sku,price,cost,stock,unit,min_stock,track_stock`), 2) map columns (auto-match header names in English/Roman Urdu), 3) preview with row-level errors (red cell + message) and summary "980 new, 15 updates (matched by SKU or barcode), 5 errors", 4) import — written in chunks sized to stay under the 200-op transaction limit (a row costs its product plus barcodes and opening movement; [03 §3](../03-sync.md#3-outbox)); progress bar; rows with errors are skipped and downloadable as `import-errors.csv`. Prices given in rupees (decimals allowed) are converted to paisa. A product name over 80 characters or a category name over 40 characters is a row error (the D1 limits). Each non-empty `barcode` cell (several allowed, separated by `;`) becomes a `product_barcodes` row. The `stock` and `cost` columns create an `opening` movement **only for new products**; for matched (updated) products they are ignored and the preview says so (use a stock count to correct stock).

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
8. Turning `Track stock` off on a tracked product shows the warning and asks before saving; after confirming, no stock movement is written, the old on-hand and history stay, and Stock history gains a "Stock tracking turned off" row showing the on-hand balance at that moment.
9. Creating a bundle with a phone, charger, case and protector at Rs 56,500 shows items total Rs 59,980, customer saves Rs 3,480, derived cost/margin and availability 3 bundles; the saved product has `kind='bundle'`, `track_stock=0` and four `bundle_items`.
10. The bundle list row shows the `Bundle` pill and "3 bundles" availability; the detail has no `Adjust stock`, opening stock or low-stock fields, and its 30-day figure counts bundles, not components.
11. Selling the bundle deducts each tracked component by the bundle quantity; an untracked service component gets no stock movement; a component out of stock shows the amber warning on Sell but does not block.
12. Deleting a component used by the bundle is blocked with the bundle name; deleting the bundle is allowed and old bills/receipts still print the old name and components.
13. Editing the recipe or bundle price updates new carts only; a saved bill and its reprint are unchanged; `Duplicate` copies the recipe but leaves SKU, barcodes, photo and stock empty.
14. A cashier sees no cost, margin or items total on the bundle list/detail or in CSV; the bundle is excluded from spreadsheet import and bulk price update; its barcode prints and price check shows the contents. English and Urdu at 1280×800 and 390×844.
