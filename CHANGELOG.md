# Changelog

All notable changes to Bikri. The version is the deployed `APP_VERSION`; migrations are listed separately.

## [Unreleased]

### POS printing, receipts and Urdu raster — 20 Nov 2026 review, PR 6
- Bundle receipt headers no longer multiply the component-net fallback by the bundle quantity, and a free bundle (`bundle_price = 0`) keeps its zero price.
- WhatsApp share text groups bundle components under one priced header; component allocation prices are no longer exposed.
- Control characters are replaced before `formatPair`/`formatColumnHeader`/`formatItemLines` can reach ESC/POS text mode; column layout requires at least 24 characters and truncation is grapheme-safe for Urdu and emoji.
- Web Serial closes and reopens when baud/flow settings change and aborts the writer and closes the port on timeout; WebUSB releases the interface and closes the device on timeout/error.
- Urdu raster lines keep their deliberate indentation and are constrained instead of clipped; centred Urdu stays centred in shared PNG/PDF images, and transparent logo pixels are blended over white.
- Day-close and supplier-return headers use the receipt-language `Tel:`/NTN/STRN labels; a missing printer config no longer queues a phantom Z-report; supplier-return reprints use fresh job ids; cancellation notices use the receipt language.
- System printing waits for `afterprint` (with a fallback) before removing the iframe; barcode labels wait for their fonts and remove the iframe promptly.
- The print-agent client allows 35 s for job submission (the agent allows 30 s) and the wizard rejects an agent whose protocol is not 1; the download tag moves to `print-agent-v0.1.3`.

### Go print agent security and release — 20 Nov 2026 review, PR 5
- The CUPS backend forces the C locale, validates job and queue ids, uses `--` before file/argument operands, and never falls back to a client job id as a cancel target (which could have run `cancel -a`).
- A failed printer enumeration now fails the job closed instead of passing an unvalidated queue name to `lp`; job ids are limited to `[A-Za-z0-9._-]` and printer names reject leading dashes/control characters.
- The Windows GDI path checks the PNG header before decoding (bounded dimensions/pixels), treats every `<= 0` GDI result as failure with `AbortDoc`, and retries partial `WritePrinter` writes; UTF-16 conversion and buffer lifetimes are checked.
- The local unpair form uses a per-process CSRF nonce plus loopback `Origin`/`Sec-Fetch-Site` checks; the `:5173` development origins are removed from saved configs and available only through `--allow-origin`.
- Rate limits cover pairing, jobs and diagnostics; print jobs are serialised per queue and the in-memory job map is capped at 100.
- The agent sets HTTP read/write timeouts, waits for the server goroutine on shutdown, and gives status/cancel requests 5-second contexts.
- Linux, macOS and Windows installers handle special `$HOME` paths, restart upgraded agents, use the modern `launchctl` commands, avoid world-writable logs, remove the config on uninstall, and restart the agent after a silent upgrade.
- The release workflow adds the Windows installer to `SHA256SUMS`.

### POS offline sync and locks — 20 Nov 2026 review, PR 4
- A pulled server row parked while a local op was pending is now applied when that op settles as `applied`/`conflict_merged`, instead of being deleted with the cursor already past it.
- Inside the exclusive push Web Lock every orphaned `sending` claim is reclaimed; without Web Locks a fresh claim stops the push instead of letting newer ops leapfrog it.
- Pull, snapshot and restore recovery share a per-tenant Web Lock, and restore recovery re-checks the restore epoch before clearing tables.
- Enrolment stores `shop_setup_completed`; an interrupted first download waits/resumes instead of showing Setup Wizard, and a missing device token returns to enrolment.
- Auto-lock checks wall-clock idle time on visibility/focus and reads timeout changes live.
- File uploads rethrow auth/schema/suspension failures and honour `Retry-After`.
- Repository idempotency checks repeat inside `writeAction`; deliveries and supplier returns reject bundles/soft-deleted products.
- Day close and expected cash keep the latest close when a backwards clock correction leaves it after `now`.

### Core money, permissions and i18n — 20 Nov 2026 review, PR 3
- `parseMoneyToPaisa('Rs. 50')` now returns 5,000 paisa (Rs 50), not 50 paisa; `PKR 250`, `Rs. 100` and `−Rs. 500` are covered.
- Inclusive tax falls back to the post-bill-discount bases when a large bill discount would otherwise make `line.revenue` negative.
- `priceBundle` uses BigInt recipe weights and a guarded scaled `ceilDiv`, so `q_i × cost_i` and `net × 1000` cannot overflow the JS safe-integer range; bundle price/refund property tests added.
- `isPinVerifierValid` requires canonical base64 with exactly a 16-byte salt and 32-byte hash.
- Unknown roles fail closed, the owner cannot be locked out by `permissions_json`, and overrides use `Object.hasOwn`.
- Urdu admin paths/status values are LTR-isolated, the stock transition arrow is consistent, and the missing support-access sentence is in both Urdu terms catalogs.
- The CSP gains `form-action 'self'; object-src 'none'`, and `/bikri/brand/*` gets the stable-asset cache policy.
- Dexie tests cover V6→V9 and V7→V9 upgrades; `DEXIE_SCHEMA_V9` and `CartReissue` are exported, and the V7 backfill streams sales instead of loading them all.

### Operator restore and export integrity — 20 Nov 2026 review, PR 2
- The restore ZIP reader pipes decompression concurrently instead of awaiting `writer.write()` before the readable side, and caps each inflated entry at 64 MiB so a crafted archive cannot hang or exhaust the browser.
- `RestoreTab` aborts its async loop on unmount, and the restore/export pagination guards now raise a visible error instead of returning silently with partial data.
- A partial unsynced-ops import shows the localized rejected/missing counts instead of the generic admin error.
- The till export and the nightly tenant extract share one `MONEY_FIELDS`/`TIME_FIELDS`/`EXPORT_HIDDEN_COLUMNS` definition in `@bikri/core`; the missing bundle, card/bank/credit and `sync_conflicts.at` columns are fixed, and products’ server-only cache columns stay out of exports.
- `tenant-extract` stamps the real `05:05 Asia/Karachi` backup restore point and uses the current `APP_VERSION`; its CSV timestamps and the till/server exports follow the shop time zone with a DST-safe offset.

### Security and sync hardening — 20 Nov 2026 review, PR 1
- A replacement bill must be paired with its `sale_voids` row in the same push, so `replaces_sale_id` can no longer skip the bundle price/recipe checks.
- Bundle discounts are measured against the pre-discount bundle price: a 100% bundle discount no longer bypasses `max_discount_bp`, and 51–99% no longer rejects even the owner.
- A simple-product edit or a purchase delivery of a bundle component is no longer rejected just because a bundle sale in the same push uses it.
- A concurrent retry of the same push re-checks `applied_ops`, guards the master UPDATE, and guards every server-authored stock/audit/cost side effect, so a retry cannot double-deduct stock or duplicate ledger/audit rows.
- The manager same-day void rule uses the void's own business date (`businessDate(created_at)`), not a client-supplied date; a sale line's date must match its parent sale.
- Product/staff/shop lookups used by later transactions update only `changed_fields`, matching the D1 write and closing the cost-only-upsert price-smuggling path.
- A void repairs stock once per product, not once per line; duplicate `refund_lines` for one sale line are rejected.
- `import-ops` refuses support devices and invalidates the usage cache.
- Migration `0026` rebuilds `sales_append_only_update` with `bundle_discount_total`; the bundle isolation cases `I25`–`I27` and the cron/static coverage gaps are now in the suite.

### Fixed — 17 Nov 2026 whole-app review
- Sync keeps running while the tab is hidden; only a 30 s grace after the sale-complete **Share** opens WhatsApp defers requests, and `pagehide` flushes pending ops (M1, D-238).
- `/bikri/icons/*` and `/bikri/fonts/*` revalidate daily instead of caching for a year; only content-hashed `/assets/*` stays immutable (M2, D-237).
- Sell tiles wrap the price row and grow to 184 px so a 5-digit price and the stock pill no longer collide; an empty bill's primary action reads **Add items**; Products shows a muted dash instead of "No category" when the shop has none; remark links and other small targets meet 44 px; a zero-budget shop shows **Writes blocked** (M3, L1–L5, D-239).
- Reports and Sales clamp custom ranges to the shop's first business day and today, warn above two years, and can no longer build hundreds of thousands of day buckets from a mistyped year; the report worker aggregates one calendar month at a time (M4, D-240).
- The Reports summary opens with four KPI cards and hides the hourly chart below three active hours; refunds appear once; the desktop Home puts the Today register first and the New sale hero in the side column (M7, D-241).
- The push checker, server-row and lookup modules are split by domain (`sync/checks/*`, `applyOpsServerRows.ts`, `applyOpsLookups.ts`); the public entry points are unchanged (M5, D-244).
- Migration `0024` repairs existing products whose server `avg_cost` was still 0 despite a catalogue cost and no stock movement (D-248).
- Query/calculation audit: shop-time-zone sold windows, older-sale refunds on the 14-day chart, bundle-safe price check/Sell/import/search paths, same-push party balances, catalogue `avg_cost` init, recipe soft-delete/idempotency guards, operator export quota, prune-floor recheck, and the related report/label fixes (D-247).
- Bundle "Sold 30 days" and the product-detail 14-day chart use the group's bundle quantity and subtract whole bundles returned on the refund date; a two-bundle sale no longer shows 1 (D-246).
- The operator console shows the active daily-budget sum and flags it above 70,000 rows/day, matching the documented Workers Paid trigger (M6, D-245).
- Push rejects over-long short-text fields (sale remarks 120 characters) and uploads must match their image magic bytes; owner sign-in binds `SIGNIN.tries`; `SCHEMA_VERSION` and `CLIENT_SCHEMA_VERSION` are both 7; D-216 is renumbered and `docs:check` rejects duplicate decision IDs (L6–L10).

### PWA

- The till checks for a new service worker hourly and again when it becomes visible, with a five-minute minimum gap, so an always-open standalone window no longer waits for the manual Settings → About check (16 Nov performance review §12, D-251).

### Tooling

- The website release gate follows same-origin JavaScript imports recursively with a visited set and a 200-script cap, closing the one-hop third-party import gap (7 Nov P3-34, D-254).
- Nightly backups count tenant rows from the D1 dump instead of a second `COUNT(*)` pass; an unparseable tenant `INSERT` fails the backup instead of writing a zero count (16 Nov review §11, D-254).
- POS declaration output moves to `.tsbuild/`, and the post-build removes legacy `dist/types`/`dist/types-node`, so ~1 MB of TypeScript declarations is no longer uploaded as static assets (16 Nov review §11, D-254).

### Design
- Owner sign-in and shop-invite emails now use an Algovyn-branded HTML layout with the Bikri POS lockup, a large code block, shop/device details and a plain-text alternative; the Home header is a "Welcome back" overview card with the business date and a branch chip.
- The desktop Today register is recomposed for the wide main column: a 20 px title, a 32 px sold figure with the bill count beside it, profit beside the sold figure, a credit row with given/received/credit-bills, the last-bill time in the title row, and a separate drawer footer on a subtle band with the “Expected · since last close” cash hint and a full-width Day close row. The phone credit-bill count is a horizontal label/value row, the count uses a lighter 18 px weight, the bill-count pill drops its icon, and negative profit uses the danger tone only while amounts are visible (D-249, D-250, D-252, D-253, D-255).
- The Home Today card no longer shows **Profit today**; sold and the bill count stay the hero, and profit remains in Reports for `cost.view` users (D-260).

### Receipts
- Settings → Shop profile & receipt gains a shop-level **Show logo on receipts** switch (migration `0025`, schema 8). It hides the uploaded logo from every receipt without deleting it; the live preview follows immediately, and Printer → **Print logo on this device** remains a device override (D-261, D-262).

### Terminology
- User-facing **Void** is renamed to **Cancel** and **Paid** is shown as **Completed** throughout the till — status, action, dialog, errors, statement badge and report labels. Internal `void`/`paid` status values and schema stay unchanged; the Sales CSV maps them to `completed`/`cancelled`, and the Staff report CSV exports `cancelled_bills,cancelled_amount` (D-259, D-262, D-263).

### Statements
- Customer statement exports always include each bill's item lines and leave out cancelled bills; the till's history still shows a cancelled bill with a **Cancelled** pill and its reversing row so the balance stays auditable (D-257, D-258).
- Supplier statements gain `From` / `To` date filters with the correct opening balance; CSV, PDF and PNG exports include each delivery's item lines.
- Clicking a supplier delivery opens a read-only detail with item lines, linked returns, totals and CSV/PDF/share export; print labels uses the remaining quantity after linked returns. A delivery saved without a supplier invoice number gets a generated `BKR-YYYYMMDD-XXXXXX` reference. Delivery line names use the current catalogue name because purchase lines have no name snapshot.

### Day close
- Reports → Day closes now shows the note recorded with each short/over close, and Printer settings gain **Print Z-report after day close** (per device, default on). The manual **Print Z-report** button still queues a report when automatic printing is off (D-264).

## [1.1.0] — 2026-11-16

### Bundles
- Fixed-recipe bundle products: a bundle is a product with `kind='bundle'`, no stock of its own, and 1–20 simple components; sales expand into ordinary component lines with the cost-weighted split, whole-bundle refunds, and one bundle header on receipts (D-229).

### Brand, shell and operator console
- New Bikri mark and PWA icons (D-216), the Graphite dark theme (D-217), the rail-only desktop shell with compact mode (D-220, D-221), the operator console refresh (D-222) and the **Update** prompt.

### Performance
- The fourth performance pass (D-231) and the P2 pass (D-226): compressed static assets, business-date report reads, bounded pushes, memoized catalogue/search, a single-statement `/api/me`, paged history/statements and a byte-reserved R2 quota.

### Documents and settings
- Optional shop name on receipts (D-232), sale remarks (D-233), optional bill details in customer statements and the A4 bank-style export (D-234, D-235), and unbounded custom report/sales ranges (D-236).

## [1.0.0] — 2026-11-02

_Cumulative feature record; 1.1.0 additions are summarized in the release section above._

### Design
- The update prompt in the rail and phone top bar now reads **Update** (the full "Update ready" stays in the tooltip and accessible name) with a teal dot on the refresh icon, so translated text no longer overflows the 88 px rail.
- Operator console refresh: rail-only desktop shell with the same 88/64 px brand rail, a bottom operator menu for the Access email, languages and Access note, a wider 1440 px content column, and a compact mobile brand header with four fitted tabs (D-222).
- Rail-only desktop shell with a compact 64 px mode toggled from the Bikri mark, Search at the foot of the rail, Settings in the staff menu, selling prices in global search, a Today-card privacy eye, roomier nav spacing and a phone page-actions menu that stays on-screen (D-220, D-221).
- Graphite dark theme: near-black canvas `#0E1014`, calmer surfaces, 3:1 borders, desaturated primary `#5EA5D4`, brand-turquoise success, and the brand-navy rail `#182E55`. Rail overlays move onto tokens so dark labels are not pure white; light theme is unchanged (D-217).
- New Bikri brand mark: an open ledger with a tick cut through both pages and a turquoise total line, with a sentence-case Bikri wordmark, in the rail, operator console, lock, enrol, setup and shop-request screens (theme-aware, reversed on navy). New PWA icons (rounded, 192/512 maskable), a 180 px Apple touch icon, and SVG + ICO favicons (D-216).
- The Udhaar khata and supplier ledger use the shared subpage header and a compact balance card (20 px amount on phones, 32 px from 640 px, with limit bar, age and promise). Party actions are one primary plus a More menu. Receive money, Pay supplier, Promise and the customer/supplier editors open as bottom sheets on phones and 32 rem dialogs on desktop, with a slim balance line, a three-up method control and a sticky footer (D-160).
- About no longer repeats the keyboard-shortcut table; the `?` sheet is the single reference. The Settings index keeps its own scroll without a visible scrollbar (D-159).
- Visual-audit follow-up: a compact Home checklist, task layouts for Import/Prices/Stock/Categories, scrollable mobile date/tab strips, an icon-only Products filter at 390, a sticky Settings index with one primary Save, a compact sticky Day-close action, a labelled status pill, recent commands, Cashier avatars, a primary Sell action on product detail, a setup language check and a single-sale chart hint (D-158).
- Urdu is now set entirely in **Noto Naskh Arabic UI**; the Nastaliq font files, faces and dependency are removed (D-157).
- Shell refinements: the staff menu lists languages as checked rows instead of a native select, the status popover shows a sync pill beside the printer pill (both open Settings), the shop name sits at the foot of the rail, and visual snapshots use a fixed pixel budget with deterministic SKUs (D-156).
- Operator console visual pass: the Bikri mark, a persistent operator identity chip, one-tone tenant headers, a single-surface Shops list, compact empty states, bidi-safe figures and dates in Urdu, and axe/snapshot coverage for the console (D-155).
- Third visual pass: a single status dot, one page-header tone, plain-language reports/day close, a Settings data-safety card with search, a `Ctrl+K` command palette and `?` shortcut sheet, a designed sale-complete beat with optional sound, a Bikri mark and first-run illustration, a Nastaliq/Naskh Urdu split, a slate-100 light surface, and deterministic Playwright snapshots (D-154).
- Second visual pass: breadcrumb and one status popover in the shell, language in the staff menu, a money signature, editorial reports with deltas/hourly/stacked mix, two-column Pay and product forms, refund running total, branded setup, a dismissible Home checklist with sample products, sortable list headers and a bulk bar, a receipt paper motif and a Balanced day-close stamp (D-153).
- Design-system pass: four named page containers, Home actions grouped into **Run the till** and **Manage** with a navy hero and a Stock count shortcut, flat date/filter strips, solid empty states, a calmer Settings placeholder, shared overlay/toast motion, two-letter product monograms, a wider Urdu Sell tile, and red kept for destructive/overdue only (D-151).
- List screens now use one surface (toolbar, summary and rows) with a shared `PageActions` menu, 56 px product rows and 44 px list targets; a layout spec checks 390/768/1280/1920 in English and Urdu, and the design checklist is in [docs/design-review-checklist.md](docs/design-review-checklist.md) (D-152).
- Vite dev serves the language catalogs again; dynamic JSON imports no longer carry Node-only import attributes.
- Settings has a centred index like the other list sections; choosing a row opens that section and, at desktop width, keeps the index beside it in the same two-column master–detail frame as the other sections (D-186, D-187).
- The Products list header now uses the shared list-surface background and the same start border as its rows, so the column labels line up with their values.
- List and table columns now use one direction-based alignment: left in English and Roman Urdu, right in Urdu, with no mixed numeric right-alignment inside a list (D-188).
- Every Products column now sorts — including Category, Avg cost and Margin — and clicking the active header or the phone direction button reverses the order (D-189).
- Sales, Udhaar and Suppliers now have the same two-way clickable header sorting, with toolbar sort controls on phones (D-190).
- Settings → About keeps the version, update check, terms and privacy cards but no longer shows external Source code or Licence links.

### Performance
- Fourth whole-app performance pass (D-231): static assets are compressed again (the `no-transform` beacon guard is HTML-only) and content-hashed JS/CSS/fonts are cached `immutable`; reports read sale lines by business date instead of scanning lifetime history; a push reads only the bundle recipes it names; `0020` adds the refund/purchase/enrolment indexes and `0021` drops 16 unused ones; a push-only cycle no longer resets the 60 s pull; catalogue/search rows and haystacks are memoized; the Sell customer picker loads only when open; Home attention uses new Dexie V9 indexes; statements render one layout, the Sales list caps at 500 rows, stock count and sale writes batch their reads; print-agent CUPS calls are cached, the print poll backs off and `Recent` sorts outside the mutex; the admin locale chunks leave the offline precache and the bundle gate now reports CSS/precache bytes.
- Remaining P2 performance pass (D-226): `/api/me` is one D1 batch; Home attention no longer re-reads the catalogue on every sale; product history and customer/supplier statements page at 200 rows with `Show older` while exports/print keep everything; the till trims local-only logs daily; R2 usage is reserved atomically per shop (`0014`) instead of listing the whole prefix on each upload; exports stream table-by-table into Blob zip parts; CI gates the 5,000-bill Sales list and a 20,000-movement push.
- Whole-app performance pass (D-225): server-side product stock cache (`0013`) so a push no longer sums every movement; snapshots/exports no longer run a full-table `COUNT(*)` at the start; the Sales list reads payments by business date and chunks-or-scans refunds/print jobs; print status is one scan; sync push reads a bounded outbox window and merge bulk-writes pages; every write action has an explicit table scope; the Sell route is lazy with idle prefetch while the offline product workspace/form stay eager (D-185); reports worker requests are serialised.
- Sell and Products now load the catalogue once and filter in memory, with a short-lived 30-day sold cache; global search uses a session index plus the invoice prefix index; print status queries only failed jobs; day-close pushes use new Device+created indexes (`0011`); sale/refund/void writes lock only the stores they touch; `Intl` formatters are cached; Home and category routes are lazy chunks while the offline product screens stay eager; the export ZIP uses one output buffer (D-185).

### Selling and back office
- Offline-first selling with three carts, held bills, cash/card/bank/wallet/udhaar payments, change, receipt printing and sharing.
- Custom date ranges in Reports and Sales are no longer capped at 366 days; the report keeps its date controls visible for any invalid selection.
- Refunds (including the part-udhaar split), voids and void-and-reissue, append-only corrections and printable notices.
- Udhaar khata with limits, statements, part payments, promises, chase list and WhatsApp reminders; the statement export can optionally append each bill's item name, quantity, unit price and line amount to CSV/PDF/PNG/print/share (the thermal item line is compact and truncated to stay on one row), the PDF/PNG is a branded A4 bank-style statement with the shop logo, address, phone, period and debit/credit summary, and **Print** is a separate header action instead of an export-menu item.
- Products, barcodes, stock adjustments/counts, weighted-average and last cost, suppliers, deliveries, pay supplier and returns to supplier.
- Expenses, cash in/out, per-device day close with expected cash, difference and Z-report.
- Reports (summary, products, stock, udhaar, staff, day closes, expenses) with CSV/PDF/PNG exports.
- Owner full export, owner server export with email sign-in, barcode labels (50×25, 38×25, 40×30 mm and A4), settings, staff/PINs, permissions and Activity.
- The shop logo is saved by the Shop profile section's Save (no separate Save logo action); its thermal preview and the receipt-preview logo persist after leaving and reopening Settings, and the receipt preview keeps its text width so the logo stays centred instead of widening the paper.
- Settings → Shop profile & receipt adds **Show shop name on receipts** (default on) for logos that already contain the name; the receipt preview now shows the shop-name line bold like the printed receipt.
- Customer statement thermal Print uses a smaller shop logo than a sale receipt (30% of the print width, max 96 dots).
- Sell has an **Add remarks** popup next to **Add discount** (an existing remark appears as a muted row with Edit); the text is saved on the sale, prints as `Remark: …` on thermal/PDF/browser receipts, and is included in the WhatsApp share text.
- English, Urdu (RTL) and Roman Urdu; printer-agnostic ESC/POS over WebUSB/Web Serial with browser-print fallback.
- Refined visual refresh: brand-navy desktop rail, a real 24/30 heading scale, dashboard-style Home, elevated Sell/Products tables and forms, icon payment method cards and card-based filters across the back office. The visual-review pass makes the master–detail split 1280-only, cards phone statements, fixes Urdu Sell tiles, quietens printer/sync status, raises Sell density, uses Inter for display money, adds sale-complete/backup/report/day-close clarity and collapses phone filters (D-145). Sell category chips show their names, Home recent bills are shop-wide and newest-first, and the rail shows only the Bikri brand.
- Reference-driven structure: icon page headers, primary + overflow actions, Home hero and register column, cart tab totals and quantity badges, descriptive payment cards, and Settings rows with icons/chevrons (D-134).
- Date ranges in Sales, Expenses and Reports are remembered per device; Expenses adds Last month and Custom; Sales rows have aligned columns; Settings is two-column on desktop; Printer/Sync have Back buttons; the lock screen and top bar show the Bikri brand and printer status text (D-135). Settings now uses a master–detail split with the index beside the selected section, every section has a Back arrow, and the top-bar printer state is a compact green/red `Printer` pill (D-137).
- Sales, Products, Udhaar and Suppliers use the desktop master–detail layout; the rail shows the shop name under Bikri again; Language is no longer a duplicate Settings row; waiting print jobs can be cancelled; the dark rail has its own navy step; owner sign-in distinguishes a missing owner email and an unenrolled device (D-138; product routes stay eager for offline edits, D-139).
- Devices import uses a visible Choose file button, the receipt preview is compact, the staff menu has a padlock icon, and the printer pill uses white text on solid green/red (D-140). Report table metric headers align with their values (D-141). The lock screen and operator console follow the selected theme, the staff menu has a user icon, and the printer pill uses the sync badge's subtle colours (D-142). Code-review remediation tightened read-only op cutoffs, ledger/stock permissions, refund checks, pull quarantine, re-enrolment cleanup, settlement, print recovery, printer text/raster handling, health/deploy gating and request logging (D-143).

### Sync, tenants and operations
- Multi-tenant D1 with every row and query scoped by `tenant_id`; per-shop IndexedDB copy and outbox.
- A write-debounced push no longer starts while the till tab is hidden (for example after Share opens WhatsApp); it flushes as soon as the till is visible, so Chromium cannot suspend the request until its HTTP/3 connection idles out.
- Device enrolment, PIN lock, owner email sign-in, admin devices, conflict handling and restore recovery.
- Operator console behind Cloudflare Access: tenants, pairing codes, devices, status changes, support access, per-shop export/restore/delete, usage and backups — restyled to match the shop shell with KPI cards, searchable/paginated shops, tenant status/profile cards and consistent forms and danger zones (D-136).
- Read-only shops with offline-safe retention of pre-status sales; operator support access is view-only, visible and time-limited.
- Nightly whole-database backup (`backup.yml`) with per-tenant manifest, private R2 copy, `age`-encrypted 90-day artifact and 30-daily/12-monthly retention.
- Code-review hardening: deploy trust gate, first-owner bootstrap, restore child lines, catalogue/audit/sale-shape checks, outbox `sending`, cart claims, discard cleanup, R2 per-shop cap, last-admin CAS, manager limits, read-only UI guards and printer/search/report fixes (D-146).
- Visual-review remediation: responsive page headers, full-width lists until selection, sticky master-detail, shop grouping across UI/exports, reports phone KPI/chart, two-card day close, supplier delivery item count, shop-card Save, live totals, mobile sync/printer status, lock banners, Urdu category names, disabled styles, theme pre-paint, skeletons and skip link (D-147).
- Sell line editing: unit price and Rs/% discount are inline on every cart line; supplier delivery lines use a clear card with a visible quantity stepper, line total and sell-price option (D-148).
- Weekly R2 file backup (`files-backup.yml`, `tools/backup/files.mjs`): every shop logo/product photo under `t/` is listed, downloaded with a sha256 manifest, tarred, `age`-encrypted and kept as a 90-day artifact (D-144).
- `tools/backup/tenant-extract.mjs` extracts one shop from a nightly backup loaded into `bikri-restore`.
- Free-tier measurement: ~117 rows and ~1.9 KB permanent growth per bill, ~153 MB per shop-year including steady-state sync tables; start a new shard around 450 MB per database. See [D-127](docs/decisions.md).
- Accessibility sweep: axe on every selling/back-office/settings route in English and the Urdu core journey, no serious/critical violations.

### Review remediation (2026-11-02)
- Restore validates the manifest and every table file/count before purging; discarding a rejected op now confirms, recomputes the bill status, and the Sync screen only reclaims stale push claims.
- Manager approvals are bound to the cart/udhaar/price they approved; hard-limit and discount checks run again when the sale is written.
- Pushes reconcile sale lines, payments and udhaar; pulls validate rows and quarantine unique collisions; exports are cut off at their start time.
- A branch move is blocked while the device has waiting ops; maintenance can return to read-only or suspended.
- Products exports follow `export.data`; promise/import writes chunk by op cost; reports aggregate in a worker; field-merge conflicts reach pull; WhatsApp share opens its tab synchronously; the operator pairing panel shows a QR.

### Second review remediation (2026-11-02)
- Cashiers are limited to today's bills of their branch everywhere (Sales, bill detail, refund URL, global search), and the Sales summary only nets refunds of the visible filtered bills.
- Read-only shops cannot open or submit import, stock adjust, delivery, return, chase-list, new-customer, barcode-generation or logo-removal writes; `ReadOnlyError` shows the read-only message.
- A root route error screen, hotkeys disabled under modals, label rows that survive parent renders, and synchronous double-click guards on product and starter-catalogue saves.
- Supplier total-owed ignores the search; the supplier ledger follows business dates; day-close card/bank/udhaar figures net voids and refunds like Reports; `avgBill` uses `mulDivRound`.
- The server accepts a void after a refund but logs a `refund_after_void` conflict; a rejected refund/void discards with the correct status. Device codes survive a branch move (migration 0005) and purchases/stock movements are reconciled. File uploads check the staff permission, and failed uploads appear in Settings → Sync with Retry.
- The Vite dev origin is allowed by the dev script; `docs/07` documents the negative-rounding guard (D-162).

### Third review remediation (2026-11-03)
- A successful push now updates the local master `rev` from `server_rev`; discarded edits restore the pre-edit row from `pull_shadow`, so a rejected costed delivery or stock-in cannot leave a stale average/last cost.
- Costed stock-ins and deliveries are accepted with `stock.adjust` / `purchase.create` without requiring `catalog.edit`; server checks now cover real business dates, the sale tax-rate range, payment direction/type/party existence, ledger party existence, sales branch moves and the last active owner.
- The operator export is a v2 `bikri-export` zip with JSON and CSV, uses the server cutoff, and the operator console can garbage-collect unreferenced R2 files under `t/<tenant>/` after 24 h.
- Support access extension updates already-enrolled support device expiry; `devices.enrolled_by` is no longer sent to tills.
- The missing `office.products.title` use is replaced with the base products title; `i18n:check` now also verifies that literal `t()` keys used by the app exist. The docs no longer require per-table Zod row schemas (D-170).

### Fifth review remediation (2026-11-04)
- Outbox replies lost after a timeout can no longer coalesce a newer edit into an already-applied op id; the restore shadow is kept/replaced correctly for a newer pending op.
- An interrupted push (reload, closed tab, stopped engine) no longer leaves claims that block later ops: each push reclaims and resends unfinished rows in sequence, so a product can never overtake its setup staff/shop rows.
- `/enrol` requires an owner PIN before leaving a connected shop; the cashier blind-count screen can be completed from denomination inputs.
- Backdated sales mirror the attributed seller's `sale.create`/`catalog.edit` checks, including a line-bound price override, and the Worker cannot skip the backdate audit when an old client omits `op.created_at`.
- Owner discount limits, supplier visibility, device admin double submits, failed imports, Customer/Supplier dialog edits and Price Check/Pay interactions are fixed.
- Shop requests cannot be rewritten by a duplicate email and an `approving` request cannot regress; owner sign-in limits and support/export claims are atomic.
- Public/import bodies are capped, migration `0007` indexes `shop_requests.status_token_hash`, and `Restore from export` is documented as an operator action in v1.
- Release gates: the website check fails closed, the backup verifies every table, `gen-tables` reads every migration, the bundle gate counts the theme/nested chunks (288 KB budget), and the e2e assertions/checks cover the repaired paths.

### Seventh review remediation (2026-11-07)
- Offline sync: a refund/void in the same push as its sale now sees the sale lines; a new cashier/shop setting is visible to later transactions; restore recovery no longer duplicates a queued ledger row; push settlement includes ledger tables; snapshots quarantine a bad row; cross-tab pushes use a lock and only reclaim stale claims.
- Money/integrity: future row times are rejected, discount overrides need a different owner/manager within their limit, payment-sourced ledger rows are restricted, `paid_now` requires its supplier ledger row, replays are idempotent, and `sales.status` follows per-line refunded quantities.
- Day close: blind count hides the expected difference; period uniqueness and the stale-form guard prevent overlapping closes; the Z-report snapshots its informational totals.
- Cash handling: the drawer opens for customer/supplier payments, pay-ins/outs, expenses, supplier returns, voids and sales/refunds with auto-print off.
- UI/print: privacy covers payment mix and expense shares; PNG/PDF receipts load the Urdu font; `Ctrl+Shift+H` is exact; reissue approvals are cart-bound; the WhatsApp toggle, auto-close, printer error and share text work.
- Platform/schema: restore confirmation and insert-only ledger import; operator audit for settings/creation/purge; migration `0010` adds append-only triggers and day-close snapshot columns; streaming body caps, cached health, no-store enrolment tokens, error-status logs, tenant-deletion PII cleanup and platform tables in the backup gate.

### Eighth review remediation (2026-11-14)
- Sync ordering: transactions are planned in outbox order again, so a sale that follows an offline delivery (or the first sale after setup's opening stock) passes its cost check; statements still apply parents-first.
- Lost responses: a replayed op answers with the row's current `rev`, and an edit of a `rev = 0` row keeps a restore point, so Discard never deletes a row the server has.
- Pull/restore: a pulled sale row cannot roll a local refund/void status backwards; restore recovery keeps a failed transaction's rows and restore point.
- Counts: a stock count derives its delta from the product's movements and snapshots update the stock cache per page, so an interrupted snapshot cannot double-apply a count.
- Guards: a malformed PIN verifier can never crash unlock, an unknown shop time zone falls back to `Asia/Karachi`, and push/import plus migration `0012` reject both.
- Performance/robustness: Dexie V4 indexes `stock_movements` by `[ref_type+ref_id]`; Home uses index counts; `pending` reports `sending` ops; a debounced push is not dropped during a running push; blobs are limited before deserialising; the tenant-scope guard catches `FROM(table)`; `isUlid`/`newId`/`lineRevenue` validate their inputs; the request log reports the thrown status.

### Ninth review remediation (2026-11-15)
- Cost: the server shop lookup now loads `cost_method`, so a shop using last cost validates each sale against `last_cost` instead of rejecting every sale as `CONSTRAINT_FAILED`.
- Refunds: `sales.status` is recomputed from the last refund line rather than the refund header, so a full refund is stored as `refunded` (not `part_refunded`) on the server and in later snapshots.
- Tenancy: the `tenantDb` guard rejects CTEs and derived tables when a tenant table is named, closing the alias-predicate bypass.
- Print agent: a job must name an enumerated OS queue; if queue enumeration fails, printing still falls back to the spooler error.
- Owner export: a failed start releases only its own 24-hour claim, so a transient failure does not block the next attempt.
- Docs/hygiene: the enrolment-code hash comment now describes the keyed HMAC and legacy fallback; local scratch E2E scripts and temporary tests are gitignored.

### Visual review remediation (2026-11-15)
- Names: product and line names use `unicode-bidi: plaintext`, so Urdu/mixed names keep their bidi order in both interfaces; `.ltr-name` now only selects the Latin face.
- Frames and lists: the 404 uses the focused page frame, admin request rows no longer collapse on phones, Activity is one surface with Clear filters, and the not-enrolled Devices state offers Enrol.
- Dates: all shop date/time output goes through `lib/date.ts`; 12-hour times use uppercase AM/PM on every screen, including list columns.
- Tables: list and report columns stay start-aligned per D-214; the dead alignment branch is removed and docs/08, the review checklist and screen 16 now state the rule.
- Actions and overlays: the embedded bill Print is quiet at ≥1280 px while the phone detail keeps it primary; Sales has one filled primary; global search and the command palette share their shape and close affordance; the shortcut sheet is complete and lists F2/Ctrl+F, and the four main lists bind it.
- Settings and selling: Add cashier sits in the record header; cart order is a device preference; credit-limit bars label Near limit/Over limit; the Rs 75 note is ordered and labelled; the Home hero has real hover/press feedback; card titles use one scale.

### Security and data
- Append-only sales, refunds, payments, ledger, stock, purchases, expenses and day closes; no hard deletes of master data.
- Full local export is owner-only (PIN verifiers are not downloadable by other roles); server export needs an admin device and owner email sign-in.
- Every tenant query goes through `tenantDb`; R2 keys are always `t/<tenant_id>/…`; cross-tenant isolation suite runs in CI.
- The pre-paint theme snippet is the external `/bikri/theme-init.js` asset, so the strict `script-src 'self'` CSP no longer blocks it; the app shell has no inline scripts (D-149).
- Full-codebase review remediation: sync contract fixes (opening balances, supplier refunds, void overrides, category/promise actors), PIN-lock and override hardening, safe pull/restore recovery, idempotent stock averages, read-only drawer/import guards, cross-tab print claims, Urdu receipt/label fonts, sale-time cost snapshots, retry-safe counts, refund-date summaries and net product analytics (D-150).

### Documentation
- [Operator guide](docs/operator-guide.md), [owner guide](docs/owner-guide.md), specification in [`docs/`](docs/00-overview.md) and decisions log in [docs/decisions.md](docs/decisions.md).

### v1.0.0 release
- Shipped on 2026-11-02 after the live backup/restore drills and the hardware checklist; v1.1.0 followed on 2026-11-16.
