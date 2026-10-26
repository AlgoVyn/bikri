# 11 — Roadmap and task list

Ordered tasks for an implementing agent. Do them **in order**; each task is one PR titled `T-0xx: <title>` with conventional commits. A task is done when its acceptance criteria (AC) pass in CI and the definition of done in [AGENTS.md](../AGENTS.md) holds. Estimates assume one experienced developer + AI assistance.

**Multi-tenancy (D-064, [13](13-multi-tenancy.md)) applies to every task:** every server query goes through `tenantDb` and is scoped to the caller's tenant, every new table follows the tenant rules of [02 §1](02-data-model.md#1-conventions), and every task that adds an endpoint, table, query, file path or export adds cases to the cross-tenant isolation suite ([10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory)) in the same PR. Tasks changed by the move to multi-tenancy are marked **(MT)**.

## Milestones

| Milestone | Weeks | Outcome |
|---|---|---|
| M0 Foundations | 1 | Monorepo, CI, deploy of an empty PWA + Worker at `https://algovyn.com/bikri/` |
| M1 Local till | 2–4 | Multi-tenant schema (T-008), then products, Sell, Pay, receipts, offline-only (single device, one tenant's local database) |
| M2 Sync, devices and tenants | 5–7 | Tenant-scoped enrolment and sync, PIN, multi-till, operator console (tenants, onboarding), shop admin on admin devices, per-shop quotas |
| M3 Back office | 8–9 | Refunds (incl. udhaar split), void/reissue, udhaar, suppliers, returns to supplier, barcode labels, expenses, day close, reports, exports |
| M4 Hardening | 10–11 | Backups, per-tenant export/restore/deletion, performance, a11y, Urdu polish, hardware checklist, v1.0.0 release |
| v2 | later | Branches, IMEI/serials, batches & expiry, Bluetooth printing, FBR, direct label-printer commands, product variants |

## M0 — Foundations

**T-001 Monorepo scaffold.** pnpm 12 workspaces + Turbo: `apps/pos`, `apps/api`, `packages/core`, `packages/db`, `packages/printer`, `packages/i18n`, `e2e`, `tools`. Biome, TypeScript **7.0.2** (exact pin, [01 §3.1](01-architecture.md#31-typescript-7-notes-decision-d-024)) strict, Node 24 `.nvmrc`, `packages/core/src/paths.ts` with `BASE_PATH`/`API_BASE`. AC: `pnpm i && pnpm build && pnpm test` pass on a clean clone; layout equals [01 §4](01-architecture.md#4-repository-layout).

**T-002 Worker + static assets.** Hono app with `basePath('/bikri/api')` and `/health`, Vite `base: '/bikri/'` building into `dist/bikri`, assets with SPA fallback, `run_worker_first: ["/bikri/api/*"]`, routes `algovyn.com/bikri` + `algovyn.com/bikri/*`, security headers ([01 §5](01-architecture.md#5-worker-and-hono)). AC: `wrangler dev` serves the PWA at `/bikri/`, `/bikri` redirects to `/bikri/`, a deep link like `/bikri/sales/x` reloads into the app, JSON at `/bikri/api/health`, unknown `/bikri/api/*` gives JSON 404; CSP header present.

**T-003 D1 migrations.** `0001_init.sql` and `0002_seed.sql` exactly as [02 §2](02-data-model.md#2-d1-schema-migration-0001_initsql). AC: migrations apply on local and remote D1; a test inserts one row per table; CHECKs reject bad rows (day close formula, payment sums). *Done in M0 with the single-shop schema; the multi-tenant schema replaces it in T-008.*

**T-004 CI/CD.** `ci.yml` (lint, typecheck, test, build, e2e, size, i18n parity, docs link check) and `deploy.yml` (website check [01 §5.5](01-architecture.md#55-release-gate-a-clean-algovyncom-decision-d-049) + migrations + deploy on `main`), `website-guard.yml` (nightly website check), `tools/check-website.mjs` with its sample-based tests ([10 §7](10-testing.md#7-ci)). AC: PR checks required; a deploy is blocked while the website check fails; merge deploys to `https://algovyn.com/bikri/`; after deploy `https://algovyn.com/` (website) is unchanged and `/bikri/api/health` returns JSON.

**T-005 PWA shell.** vite-plugin-pwa (prompt update), manifest (name Bikri, icons, `display: standalone`, `id`/`start_url`/`scope` = `/bikri/`), service worker at `/bikri/sw.js` with scope `/bikri/` and `bikri-*` cache names, precache, fonts self-hosted, `storage.persist()`. AC: Lighthouse PWA installable; app loads offline after first visit; the service worker does not control `https://algovyn.com/` (website).

**T-006 Design tokens and UI kit.** Tokens from [08 §2](08-ux-guidelines.md#2-design-tokens-appspossrcstylestokenscss-tailwind-4-theme), shared components from [screens/README](screens/README.md#shared-building-blocks-implement-once-in-appspossrccomponents). AC: Storybook-free component test page `/dev/ui` (dev only) shows all components in light/dark/RTL; axe passes.

**T-007 i18n.** i18next with `en`, `ur`, `roman-ur`; RTL switching; digit normalisation; parity check script. AC: switching language flips `dir` and all visible strings; CI fails on a missing key.

## M1 — Local till

**T-008 Multi-tenant schema (MT, new, first).** Rewrite `packages/db/migrations/0001_init.sql` and `0002_seed.sql` **in place** to the SQL blocks of [02 §2](02-data-model.md#2-d1-schema-migration-0001_initsql) (M0 was never deployed, D-072); keep `SCHEMA_VERSION` 1. Rewrite `apps/api/test/migrations.test.ts` for two tenants (tenants row first; one valid row per table in each tenant with **colliding ids**; per-tenant uniques; a cross-tenant reference fails the composite FK), add the schema check I20 ([10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory)), and add `apps/api/src/db/tenantDb.ts` (shard lookup + `tenant_id` binding) with the lint rule / grep test I19 even though few queries exist yet. AC: `node tools/check-docs.mjs` passes again; migration tests and I19–I20 pass.

**T-010 Core money module.** [07](07-money-rules.md) functions, including both tax modes (§3), the refund split (§6.1) and supplier returns (§10). AC: all `docs/fixtures/money-*.json` vectors pass (T1–T10, R1–R10, C1–C4, D1–D3, S1–S3); property tests pass.

**T-011 Dexie schema and repositories (MT).** [02 §3](02-data-model.md#3-dexie-schema-till); one Dexie database per tenant named `bikri-<tenant_id>`, opened from `localStorage['bikri.active_tenant']` (no `tenant_id` column locally; `kv.tenant`); until enrolment exists (T-034) dev and test builds use a fixed local tenant `dev` (`bikri-dev`), production builds always enrol first. Each repository writes row + outbox op in one transaction; caches `stock_levels`, `party_balances`; rebuild. AC: integration tests with fake-indexeddb; killing a transaction midway leaves neither row nor op; two tenant databases opened in one test never see each other's rows.

**T-012 Setup wizard (local) (MT).** [screens/01](screens/01-setup-wizard.md); shop name pre-filled from `kv.tenant.display_name`; upserts the default branch that tenant creation made. AC: screen ACs 1–7 (8 after T-034).

**T-013 App shell + Home (MT).** [screens/04](screens/04-home.md); the rail shows the shop's name (never another shop's). AC: screen ACs.

**T-014 Products list/detail/form + categories.** [screens/08](screens/08-products.md) without import and bulk update. AC: ACs 1, 2, 4, 7.

**T-015 Product photos.** Capture/crop/WebP, local storage, `file_queue` (upload in T-033); `image_key` is the relative key (no tenant in it). AC: photo shows on tile offline.

**T-016 Sell screen.** [screens/05](screens/05-sell.md). AC: ACs 1–9 (perf AC with large fixture).

**T-017 Pay modal + sale recipe.** [screens/06](screens/06-pay.md). AC: ACs 1–7.

**T-018 Sale complete + share.** [screens/07](screens/07-sale-complete.md). AC: ACs 1–4.

**T-019 Print pipeline.** `packages/printer` Block model, ESC/POS encoder, templates 58/80 mm, raster logo/Urdu ([06](06-printing.md)). AC: golden byte files for sale-basic at 58/80; Urdu receipt rendered as image.

**T-020 Transports + printer setup.** Printer-agnostic: WebUSB, Web Serial, system print (58/80 mm CSS), drawer kick, print jobs and retry, the printer setup wizard and test print ([06 §8](06-printing.md#8-printer-setup-and-test-print-per-device), [screens/17 printer](screens/17-settings.md#printer)). AC: mocked USB and mocked Serial tests at 32 and 48 chars/line; failure keeps sale; H1–H5 manual checks on whatever printer the shop buys.

**T-021 Stock adjust and count.** [screens/09](screens/09-stock-adjust.md). AC: ACs 1–3, 5.

**T-022 Price check.** [screens/18](screens/18-price-check.md). AC: ACs.

**T-023 Import spreadsheet + bulk price update.** [screens/08](screens/08-products.md#import-spreadsheet). Imports into the active tenant's database only. AC: ACs 5, 6.

## M2 — Sync and devices

**T-030 Device auth + enrolment API (MT).** `devices`, `enrolment_codes` (per tenant, `is_admin` / `grants_admin`), `/api/devices/enrol` (code → tenant), `/api/me` (tenant, `poll_after_ms`), `deviceAuth` setting `c.var.tenant`, `tenantGate` (`TENANT_SUSPENDED`, `MAINTENANCE`) ([04](04-api.md), [05 §2](05-auth-and-roles.md#2-device-enrolment)). AC: Worker tests for valid/used/expired code, revoked token, suspended tenant; isolation I9, I10, I15.

**T-031 Operator console (MT).** `accessAuth` JWT verification (`aud`, `iss`, `exp`, email), `sameOrigin` check, `/admin` pages: Overview (account and per-tenant usage), Tenants (create with owner pairing code, edit, suspend/reactivate, delete request), tenant detail (devices, revoke, issue code, import unsynced ops, owner PIN reset), Backups ([screens/19](screens/19-admin.md), [04 §3.7](04-api.md#37-operator-endpoints-cloudflare-access)). AC: screen 19 ACs; a cross-origin POST to `/bikri/api/admin/*` gets 403; creating a tenant writes the branch, expense categories and pairing code in one batch.

**T-032 Push/pull (MT).** [03](03-sync.md) protocol scoped to the token's tenant, `applied_ops`, `change_log` (per-tenant cursors, rows without `tenant_id`), conflicts, avg cost recompute, sales status recompute, `tenant_usage` counter. AC: sync test cases 1–15 and 21–22 in [03 §9](03-sync.md#9-test-cases-must-exist-in-appsapi-and-appspos-tests) (bisection, guarded updates, restore recovery, older-schema clients, import, tenant isolation) + extras in [10 §3](10-testing.md#3-sync-tests); isolation I1–I6, I11, I13.

**T-033 File upload/download (MT).** `PUT/GET /api/files`, R2 keys `t/<tenant_id>/…` added by the server, `file_queue` worker. AC: photo from device A appears on device B of the same shop; isolation I7.

**T-034 Enrol screen + initial sync (MT).** [screens/02](screens/02-enrol.md) with the owner pairing code flow and the shop name shown after connecting; creates and activates `bikri-<tenant_id>`; "Leave this shop"; initial sync uses the tenant-scoped snapshot: implement `GET /api/sync/snapshot` and the client snapshot loader here ([03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot)). AC: screen ACs; a new device ends with the same rows as its tenant on the server; E2E journey 21.

**T-035 PIN lock, roles, permissions, override.** [screens/03](screens/03-pin-lock.md), [05 §4–6](05-auth-and-roles.md#4-staff-pins-and-session), server-side checks. AC: screen ACs; Worker rejects refund from a cashier without override.

**T-036 Sync UI.** badge, offline banner, Settings → Sync. AC: E2E journey 6 and 7.

**T-037 Pruning and stale tills (MT).** `410 SNAPSHOT_REQUIRED` on pull, resumable snapshot (`kv.snapshot_state`, non-blocking banner on a till that has data; also used by restore recovery), `scheduled()` prune cron for all tenants (`change_log` 30 days with per-tenant `tenants.change_log_floor`, `applied_ops` 90 days, expired enrolment codes, `tenant_usage` 90 days, tenant deletion chunks, ≤ 40 D1 calls per run), the 7/25-day Home warnings ([03 §4.3–4.4](03-sync.md#43-snapshot--get-apisyncsnapshot)). AC: sync tests 16–20; E2E journey 20; isolation I12, I16.

**T-038 Shop admin on admin devices (MT, new).** `/api/shop/*` with `shopAdmin` ([04 §3.8](04-api.md#38-shop-admin-endpoints-admin-device), [05 §3](05-auth-and-roles.md#3-shop-admin-on-admin-devices)); Settings → Devices (add a till with code + QR, rename, move branch, admin on/off, revoke, import unsynced ops) and Settings → Sync → Conflicts acknowledge, owner-only (`devices.manage`) ([screens/17](screens/17-settings.md#devices-admin-devices-owner-only)). AC: E2E journey 15 (shop-admin part); a non-admin device gets 403; last admin device cannot be revoked by the shop; isolation I8.

**T-039 Per-shop quotas (MT, new).** `tenantGate` budget check, `503 TENANT_QUOTA` with `Retry-After`, `poll_after_ms` (doubling above 80 %), sync badge state "Daily sync limit reached", console usage bars ([13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)). AC: sync test 23; E2E journey 22; isolation I14.

## M3 — Back office

**T-040 Sales history + bill detail.** [screens/10](screens/10-sales-and-bill-detail.md). AC: ACs 1, 4, 5.

**T-041 Refunds.** [screens/11](screens/11-refund.md), including the automatic paid/udhaar split ([07 §6.1](07-money-rules.md#61-refunds-on-udhaar-bills)) and nullable `refunds.method`. AC: ACs 1–8; E2E journeys 8 and 16.

**T-042 Void and reissue.** AC: screen 10 ACs 2, 3.

**T-043 Customers + udhaar + statement + reminders.** [screens/12](screens/12-udhaar.md). AC: ACs 1–3, 6, 7.

**T-044 Promises + chase list.** AC: screen 12 ACs 4, 5.

**T-045 Suppliers + deliveries + pay supplier.** [screens/13](screens/13-suppliers-and-purchases.md). AC: ACs 1–5.

**T-046 Expenses + cash in/out.** [screens/14](screens/14-expenses.md). AC: ACs 1–4.

**T-047 Day close + Z-report.** [screens/15](screens/15-day-close.md), including `supplier_cash_in`. AC: ACs 1–7.

**T-048 Reports.** [screens/16](screens/16-reports.md). AC: ACs 1–6.

**T-049 Exports.** CSV for every list (REQ-B02), PDF for reports/statements, full export zip ([09 §3.3](09-backups-and-ops.md#33-restore-from-the-owners-json-export-new-deploy--leaving-cloudflare)). AC: each list's CSV header documented and tested.

**T-050 Settings (remaining sections) + Activity.** Activity also shows the operator's `operator_export` / `operator_import` / `tenant_restore` rows. [screens/17](screens/17-settings.md), including the "Prices include tax" switch (shown only when tax > 0, `shop.tax_mode`; receipts and cart per [07 §3](07-money-rules.md#3-bill-totals)) and Settings → Labels. AC: ACs 1–8; E2E journey 19.

**T-051 Return to supplier.** `supplier_returns` / `supplier_return_lines`, recipe, `payments` purpose `supplier_refund`, ledger and day-close effects, server checks and `over_return` conflicts, `SUPPLIER RETURN` slip, supplier ledger rows ([screens/13](screens/13-suppliers-and-purchases.md#return-to-supplier), [07 §10](07-money-rules.md#10-return-to-supplier)). AC: screen 13 ACs 6–8; vectors S1–S3 and D3; E2E journey 17; Worker tests in [10 §3](10-testing.md#3-sync-tests).

**T-052 Barcode labels.** `packages/printer/labels` (Code 128 encoder, SVG, label layouts 50×25, 38×25, 40×30 mm and A4 3×8), `/labels` dialog from product detail, product list selection and delivery saved, `Generate barcode`, Settings → Labels ([screens/20](screens/20-barcode-labels.md)). AC: screen 20 ACs 1–6; E2E journey 18; H13 at release.

## M4 — Hardening and release

**T-060 Backups workflow (MT).** [09 §2](09-backups-and-ops.md#2-nightly-backup-workflow-githubworkflowsbackupyml): one whole-database export, manifest with per-tenant counts, encrypted with the operator's key. AC: a run produces R2 object + manifest + encrypted artifact; restore drill 3.2 done on a scratch DB.

**T-061 Restore epoch + maintenance mode (MT).** Per-tenant `restore_epoch` and `status = 'maintenance'`, plus the deployment-wide `MAINTENANCE` var. AC: sync extras pass; Time Travel drill 3.1 on a scratch DB.

**T-062 Performance pass (MT).** Budgets [08 §7](08-ux-guidelines.md#7-performance-budgets) with `large.json`; measure D1 bytes and rows written per bill and per shop-day with two large tenants and update [13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop). AC: CI perf tests green; `EXPLAIN QUERY PLAN` of every hot query uses an index starting with `tenant_id`.

**T-063 Accessibility + Urdu polish.** AC: axe 0 serious; H10 passes; native Urdu speaker review of all strings.

**T-064 Hardware checklist.** [10 §6](10-testing.md#6-manual-hardware-checklist-before-each-release). AC: H1–H14 recorded.

**T-066 Tenant export, restore and deletion (MT, new).** Console export (zip in the browser), maintenance → purge → import → restore epoch, `tools/backup/tenant-extract.mjs` (one tenant out of a nightly backup loaded into `bikri-restore`), deletion confirm flow + cron deletion and R2 prefix cleanup ([09 §3.4–3.5](09-backups-and-ops.md#34-restore-one-tenant), [13 §7](13-multi-tenancy.md#7-tenant-lifecycle)). AC: drill H14; isolation I16–I18.

**T-065 Release v1.0.0.** Changelog, tag, deploy, `docs/operator-guide.md` (setup Cloudflare, create a shop, pairing codes, budgets, export/restore/delete) and `docs/owner-guide.md` for shop owners (connect the first device, add tills and staff, printer and label tips). AC: fresh Cloudflare account set up from the operator guide in < 30 min; a second shop onboarded from the guides in < 15 min; the [go-live checklist](09-backups-and-ops.md#7-go-live-checklist) is complete, including a passing website check (no third-party scripts, no service worker on `algovyn.com`) and the isolation suite.

## v2 backlog (ordered by value)

| ID | Feature | Notes |
|---|---|---|
| T-100 | Multiple branches | `branch_id` already on every ledger row (within a tenant); branch switcher, per-branch stock and reports, transfers (`transfer_in/out`) |
| T-101 | IMEI / serial tracking | `products.track_serial`; `serials` table (serial, product, status in_stock/sold/returned, sale_line_id); scan IMEI at sale; warranty lookup by IMEI |
| T-102 | Bluetooth printing | Web Bluetooth GATT for BLE printers; Android only |
| T-103 | Batches & expiry | `pack_size_milli`, batch table; FEFO selling |
| T-104 | Direct label-printer printing | TSPL/ZPL commands over WebUSB/Web Serial for label printers (v1 prints labels through the browser, T-052) |
| T-105 | Per-product tax rates | `products.tax_rate_bp` |
| T-106 | FBR POS integration | [12-fbr-later](12-fbr-later.md) |
| T-107 | Customer-facing display | second window with cart + total |
| T-108 | Erase personal data | [09 §6](09-backups-and-ops.md#6-data-retention-and-privacy) |
| T-109 | Recurring expenses (rent, salary reminders) | |
| T-110 | Product variants | Parent product with options (e.g. colour × length) generating child SKUs, shared photo/category, variant picker on Sell; v1 uses one product per variant (D-050) |
| T-111 | Shards | Second D1 binding, tenant move between shards ([13 §4](13-multi-tenancy.md#4-shards-later-not-built-in-v1)); needed when the primary DB nears 70 % of its size limit |
| T-112 | Several shops in one browser | Shop switcher at the PIN lock (one Dexie database per tenant already, D-068); open question 7 in [13 §9](13-multi-tenancy.md#9-open-questions-owner-decision-needed) |
| T-113 | Stronger shop-owner sign-in | Passkeys (WebAuthn) or email OTP for shop-admin actions; open question 3 |
