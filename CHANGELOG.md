# Changelog

All notable changes to Bikri. The version is the deployed `APP_VERSION`; migrations are listed separately.

## [Unreleased] — 1.0.0 release candidate

### Selling and back office
- Offline-first selling with three carts, held bills, cash/card/bank/wallet/udhaar payments, change, receipt printing and sharing.
- Refunds (including the part-udhaar split), voids and void-and-reissue, append-only corrections and printable notices.
- Udhaar khata with limits, statements, part payments, promises, chase list and WhatsApp reminders.
- Products, barcodes, stock adjustments/counts, weighted-average and last cost, suppliers, deliveries, pay supplier and returns to supplier.
- Expenses, cash in/out, per-device day close with expected cash, difference and Z-report.
- Reports (summary, products, stock, udhaar, staff, day closes, expenses) with CSV/PDF/PNG exports.
- Owner full export, owner server export with email sign-in, barcode labels (50×25, 38×25, 40×30 mm and A4), settings, staff/PINs, permissions and Activity.
- English, Urdu (RTL) and Roman Urdu; printer-agnostic ESC/POS over WebUSB/Web Serial with browser-print fallback.
- Refined visual refresh: brand-navy desktop rail, a real 24/30 heading scale, dashboard-style Home, elevated Sell/Products tables and forms, icon payment method cards and card-based filters across the back office. Sell category chips show their names, Home recent bills are shop-wide and newest-first, and the rail shows only the Bikri brand.

### Sync, tenants and operations
- Multi-tenant D1 with every row and query scoped by `tenant_id`; per-shop IndexedDB copy and outbox.
- Device enrolment, PIN lock, owner email sign-in, admin devices, conflict handling and restore recovery.
- Operator console behind Cloudflare Access: tenants, pairing codes, devices, status changes, support access, per-shop export/restore/delete, usage and backups.
- Read-only shops with offline-safe retention of pre-status sales; operator support access is view-only, visible and time-limited.
- Nightly whole-database backup (`backup.yml`) with per-tenant manifest, private R2 copy, `age`-encrypted 90-day artifact and 30-daily/12-monthly retention.
- `tools/backup/tenant-extract.mjs` extracts one shop from a nightly backup loaded into `bikri-restore`.
- Free-tier measurement: ~117 rows and ~1.9 KB permanent growth per bill, ~153 MB per shop-year including steady-state sync tables; start a new shard around 450 MB per database. See [D-127](docs/decisions.md).
- Accessibility sweep: axe on every selling/back-office/settings route in English and the Urdu core journey, no serious/critical violations.

### Security and data
- Append-only sales, refunds, payments, ledger, stock, purchases, expenses and day closes; no hard deletes of master data.
- Full local export is owner-only (PIN verifiers are not downloadable by other roles); server export needs an admin device and owner email sign-in.
- Every tenant query goes through `tenantDb`; R2 keys are always `t/<tenant_id>/…`; cross-tenant isolation suite runs in CI.

### Documentation
- [Operator guide](docs/operator-guide.md), [owner guide](docs/owner-guide.md), specification in [`docs/`](docs/00-overview.md) and decisions log in [docs/decisions.md](docs/decisions.md).

### Pending before the v1.0.0 tag
- Live backup run + restore drills H11/H14, manual hardware checklist H1–H14, native Urdu review and the go-live website check.
