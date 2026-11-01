# Changelog

All notable changes to Bikri. The version is the deployed `APP_VERSION`; migrations are listed separately.

## [Unreleased] — 1.0.0 release candidate

### Design
- Visual-audit follow-up: a compact Home checklist, task layouts for Import/Prices/Stock/Categories, scrollable mobile date/tab strips, an icon-only Products filter at 390, a sticky Settings index with one primary Save, a compact sticky Day-close action, a labelled status pill, recent commands, Cashier avatars, a primary Sell action on product detail, a setup language check and a single-sale chart hint (D-158).
- Urdu is now set entirely in **Noto Naskh Arabic UI**; the Nastaliq font files, faces and dependency are removed (D-157).
- Shell refinements: the staff menu lists languages as checked rows instead of a native select, the status popover shows a sync pill beside the printer pill (both open Settings), the shop name sits at the foot of the rail, and visual snapshots use a fixed pixel budget with deterministic SKUs (D-156).
- Operator console visual pass: the Bikri mark, a persistent operator identity chip, one-tone tenant headers, a single-surface Shops list, compact empty states, bidi-safe figures and dates in Urdu, and axe/snapshot coverage for the console (D-155).
- Third visual pass: a single status dot, one page-header tone, plain-language reports/day close, a Settings data-safety card with search, a `Ctrl+K` command palette and `?` shortcut sheet, a designed sale-complete beat with optional sound, a Bikri mark and first-run illustration, a Nastaliq/Naskh Urdu split, a slate-100 light surface, and deterministic Playwright snapshots (D-154).
- Second visual pass: breadcrumb and one status popover in the shell, language in the staff menu, a money signature, editorial reports with deltas/hourly/stacked mix, two-column Pay and product forms, refund running total, branded setup, a dismissible Home checklist with sample products, sortable list headers and a bulk bar, a receipt paper motif and a Balanced day-close stamp (D-153).
- Design-system pass: four named page containers, Home actions grouped into **Run the till** and **Manage** with a navy hero and a Stock count shortcut, flat date/filter strips, solid empty states, a calmer Settings placeholder, shared overlay/toast motion, two-letter product monograms, a wider Urdu Sell tile, and red kept for destructive/overdue only (D-151).
- List screens now use one surface (toolbar, summary and rows) with a shared `PageActions` menu, 56 px product rows and 44 px list targets; a layout spec checks 390/768/1280/1920 in English and Urdu, and the design checklist is in [docs/design-review-checklist.md](docs/design-review-checklist.md) (D-152).
- Vite dev serves the language catalogs again; dynamic JSON imports no longer carry Node-only import attributes.

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
