# Changelog

All notable changes to Bikri. The version is the deployed `APP_VERSION`; migrations are listed separately.

## [Unreleased] — 1.0.0 release candidate

### Design
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
- Sell and Products now load the catalogue once and filter in memory, with a short-lived 30-day sold cache; global search uses a session index plus the invoice prefix index; print status queries only failed jobs; day-close pushes use new Device+created indexes (`0011`); sale/refund/void writes lock only the stores they touch; `Intl` formatters are cached; Home and category routes are lazy chunks while the offline product screens stay eager; the export ZIP uses one output buffer (D-185).

### Selling and back office
- Offline-first selling with three carts, held bills, cash/card/bank/wallet/udhaar payments, change, receipt printing and sharing.
- Refunds (including the part-udhaar split), voids and void-and-reissue, append-only corrections and printable notices.
- Udhaar khata with limits, statements, part payments, promises, chase list and WhatsApp reminders.
- Products, barcodes, stock adjustments/counts, weighted-average and last cost, suppliers, deliveries, pay supplier and returns to supplier.
- Expenses, cash in/out, per-device day close with expected cash, difference and Z-report.
- Reports (summary, products, stock, udhaar, staff, day closes, expenses) with CSV/PDF/PNG exports.
- Owner full export, owner server export with email sign-in, barcode labels (50×25, 38×25, 40×30 mm and A4), settings, staff/PINs, permissions and Activity.
- English, Urdu (RTL) and Roman Urdu; printer-agnostic ESC/POS over WebUSB/Web Serial with browser-print fallback.
- Refined visual refresh: brand-navy desktop rail, a real 24/30 heading scale, dashboard-style Home, elevated Sell/Products tables and forms, icon payment method cards and card-based filters across the back office. The visual-review pass makes the master–detail split 1280-only, cards phone statements, fixes Urdu Sell tiles, quietens printer/sync status, raises Sell density, uses Inter for display money, adds sale-complete/backup/report/day-close clarity and collapses phone filters (D-145). Sell category chips show their names, Home recent bills are shop-wide and newest-first, and the rail shows only the Bikri brand.
- Reference-driven structure: icon page headers, primary + overflow actions, Home hero and register column, cart tab totals and quantity badges, descriptive payment cards, and Settings rows with icons/chevrons (D-134).
- Date ranges in Sales, Expenses and Reports are remembered per device; Expenses adds Last month and Custom; Sales rows have aligned columns; Settings is two-column on desktop; Printer/Sync have Back buttons; the lock screen and top bar show the Bikri brand and printer status text (D-135). Settings now uses a master–detail split with the index beside the selected section, every section has a Back arrow, and the top-bar printer state is a compact green/red `Printer` pill (D-137).
- Sales, Products, Udhaar and Suppliers use the desktop master–detail layout; the rail shows the shop name under Bikri again; Language is no longer a duplicate Settings row; waiting print jobs can be cancelled; the dark rail has its own navy step; owner sign-in distinguishes a missing owner email and an unenrolled device (D-138; product routes stay eager for offline edits, D-139).
- Devices import uses a visible Choose file button, the receipt preview is compact, the staff menu has a padlock icon, and the printer pill uses white text on solid green/red (D-140). Report table metric headers align with their values (D-141). The lock screen and operator console follow the selected theme, the staff menu has a user icon, and the printer pill uses the sync badge's subtle colours (D-142). Code-review remediation tightened read-only op cutoffs, ledger/stock permissions, refund checks, pull quarantine, re-enrolment cleanup, settlement, print recovery, printer text/raster handling, health/deploy gating and request logging (D-143).

### Sync, tenants and operations
- Multi-tenant D1 with every row and query scoped by `tenant_id`; per-shop IndexedDB copy and outbox.
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

### Security and data
- Append-only sales, refunds, payments, ledger, stock, purchases, expenses and day closes; no hard deletes of master data.
- Full local export is owner-only (PIN verifiers are not downloadable by other roles); server export needs an admin device and owner email sign-in.
- Every tenant query goes through `tenantDb`; R2 keys are always `t/<tenant_id>/…`; cross-tenant isolation suite runs in CI.
- The pre-paint theme snippet is the external `/bikri/theme-init.js` asset, so the strict `script-src 'self'` CSP no longer blocks it; the app shell has no inline scripts (D-149).
- Full-codebase review remediation: sync contract fixes (opening balances, supplier refunds, void overrides, category/promise actors), PIN-lock and override hardening, safe pull/restore recovery, idempotent stock averages, read-only drawer/import guards, cross-tab print claims, Urdu receipt/label fonts, sale-time cost snapshots, retry-safe counts, refund-date summaries and net product analytics (D-150).

### Documentation
- [Operator guide](docs/operator-guide.md), [owner guide](docs/owner-guide.md), specification in [`docs/`](docs/00-overview.md) and decisions log in [docs/decisions.md](docs/decisions.md).

### Pending before the v1.0.0 tag
- Live backup run + restore drills H11/H14, manual hardware checklist H1–H14, native Urdu review and the go-live website check.
