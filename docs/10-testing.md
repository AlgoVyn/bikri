# 10 — Testing

Every task in [11-roadmap](11-roadmap.md) is done only when its tests exist and pass in CI. Test tools: Vitest 5 (unit, `packages/*` and `apps/pos`), `@cloudflare/vitest-plugin` (Worker + D1 in Miniflare, D-055), `fake-indexeddb` (Dexie in Node), Playwright 1.64 (E2E), axe-core (a11y).

## 1. Test pyramid and targets

| Level | Location | Covers | Coverage target |
|---|---|---|---|
| Unit | `packages/core/**/*.test.ts` | money (07), ids, formatting, phone, i18n keys, permission checks | 100% lines for `money/` |
| Unit | `packages/printer/**/*.test.ts` | Block model → ESC/POS bytes, line wrapping, raster | 95% |
| Integration (till) | `apps/pos/src/**/*.test.ts` with fake-indexeddb | repositories write row + outbox atomically, rebuild caches, pull merge | 90% for `db/`, `sync/` |
| Integration (Worker) | `apps/api/test/*.test.ts` with the vitest plugin, real migrations applied | every endpoint, auth, push idempotency, conflicts, avg cost recompute, limits | 90% |
| **Isolation (Worker + till)** | `apps/api/test/isolation/*.test.ts`, `e2e/isolation.spec.ts` | cross-tenant leakage, §8 | **every endpoint and every table; required** |
| E2E | `e2e/*.spec.ts` (Playwright, Chromium; WebKit for the phone profile) | user journeys below against `wrangler dev` + local D1 | all journeys |
| Manual | checklist §6 | real printers, drawer, scanners, phones | before each release |

## 2. Money vectors (mandatory)

`packages/core/money/vectors.test.ts` loads every file in `docs/fixtures/` and asserts all fields:

- `money-totals.json` — T1–T10 → `computeCart()` output (every top-level field and every line allocation incl. `revenue`; T9–T10 tax-inclusive).
- `money-refunds.json` — R1–R4 → `computeRefundLine()` + `roundCashRefund()`; R5–R10 → `splitRefund()` (udhaar part, paid part, method, amount, rounding).
- `money-cost.json` — C1–C4 → `nextAvgCost()`.
- `money-dayclose.json` — D1–D3 → `computeDayClose()` (incl. `supplier_cash_in`).
- `money-supplier-returns.json` — S1–S3 → `computeSupplierReturn()` (unit credit, totals, return difference, suggested refund, ledger amounts, balance after).
- `barcode-code128.json` — `packages/printer/labels/code128.test.ts` → `encodeCode128()` symbols, check and module count.

Add a property-based test (fast-check) for: Σ allocations = amount; Σ line finals = total (both tax modes); inclusive mode `Σ revenue + tax = total − rounding`; refunds of all units in any split = line final; over any sequence of refunds of one bill Σ `udhaar_part` ≤ `udhaar_amount` and Σ cash `amount` ≤ `paid_total`; `|rounding| ≤ round_total_to / 2`.

## 3. Sync tests

The 20 cases in [03 §9](03-sync.md#9-test-cases-must-exist-in-appsapi-and-appspos-tests) plus:

- Over-refund from two devices → both accepted + `sync_conflicts` `over_refund`.
- `restore_epoch` change → client re-pulls and re-pushes; no duplicate sales on server.
- `MAINTENANCE` → client keeps ops, badge "n waiting", resumes.
- Push batch with 200 ops / 512 KB boundary: 201 ops → `400 VALIDATION_FAILED`; > 1 MB → `413 PAYLOAD_TOO_LARGE`.
- Refund with an udhaar part: push of refund + payment + ledger rows passes the server split checks; the same refund without its ledger row → `CONSTRAINT_FAILED`.
- Supplier return with money received: rows pass the checks; a return line linked to another supplier's delivery → `CONSTRAINT_FAILED`; over-return from two tills → both accepted + `over_return`.
- No repository transaction writes more than 200 outbox ops (60-line bill, refund, delivery and return; import chunk of 50; bulk price chunk of 100).
- Worker CPU: a 200-op push finishes under 10 ms CPU in Miniflare's profile (`performance.now` guard as a proxy; fail test at 8 ms).

## 4. Fixtures

| File | Contents |
|---|---|
| `e2e/fixtures/shop-basic.json` | tenant `algovyn-mobiles`, shop "Algovyn Mobiles", branch Main/INV, owner Adnan PIN 2580, manager Bilal PIN 3691, cashier Sana PIN 4725, tax 0, round to Rs 1 |
| `e2e/fixtures/catalog-electronics.json` | 40 products: phones (Rs 25,000–1,20,000), chargers, cables (one sold per metre, unit `m`), earbuds, power banks, covers; barcodes `8964000000011`…; costs; opening stock; 2 with `track_stock = 0` (repair labour, screen fitting) |
| `e2e/fixtures/customers.json` | 10 customers incl. Ali (`+923001234567`, limit Rs 40,000, opening Rs 5,000), Hamza (no phone), one with hard limit |
| `e2e/fixtures/suppliers.json` | 3 suppliers incl. "Hall Road Traders" opening Rs 20,000 |
| `e2e/fixtures/sale-basic.json` | the T2 cart: phone Rs 42,000 less Rs 2,000 + earbuds Rs 3,500, bill discount Rs 500, cash tendered Rs 50,000 → expected totals, payments, change Rs 7,000, receipt text snapshot |
| `e2e/fixtures/shop-other.json` | second tenant `hall-road-mobiles`, shop "Hall Road Mobiles": **the same ULIDs** for its branch, owner staff, 3 products and 2 customers as shop-basic, the same SKUs, barcodes, bill prefix `INV` and invoice numbers, different names and prices — so any missing `tenant_id` filter shows up as a wrong name or price |
| `e2e/fixtures/large.json` (generated by `node tools/seed/large.ts`; gitignored, ~68 MB) | 1,000 products, 20,000 bills over 120 days, 500 customers — for performance tests; the tests build the same data in memory |

Seed loader: `pnpm seed --tenant=algovyn-mobiles --fixture=shop-basic,catalog-electronics` creates the tenant if needed and writes via the normal repositories (so outbox/sync paths are exercised) or directly into D1 for Worker tests.

## 5. E2E journeys (each in EN and UR, desktop 1280×800 and phone 390×844)

1. Enrol with code → setup wizard → first product → sale → receipt preview.
2. Scan-only sale with cash and change (sale-basic) — receipt snapshot equals expected text.
3. Split payment cash + JazzCash + udhaar → customer balance.
4. Below-cost line as cashier → manager override → audit row.
5. Three carts + hold/resume + reload.
6. Offline: go offline (Playwright `context.setOffline(true)`), make 5 sales, reload, go online → all 5 on server, badge Synced.
7. Two devices (two browser contexts with different tokens): concurrent price edit → field merge; concurrent sale of last unit → stock −1 on both after sync.
8. Partial refund (R1) → cash Rs 3,460 → bill Part refunded → refund receipt.
9. Void & reissue.
10. Udhaar: sale → reminder URL (intercept popup) → receive payment → statement balances → promise kept.
11. Delivery with paid now cash → day close D1 → short Rs 40 → Z-report.
12. Reports: profit equals the T2 expectation; CSV export file content.
13. Printer: WebUSB and Web Serial mocked via injected `navigator.usb` / `navigator.serial` fakes recording bytes → bytes equal the `packages/printer` golden files for 58 mm and 80 mm; the setup wizard's test print works on both; failure path keeps the sale (REQ-B15).
14. Settings: tax change affects new sales only; cashier cannot reach owner settings by URL.
15. Operator console (Access mocked by a test-only `ACCESS_TEST_EMAIL` var honoured only when `ENV=test`): create a tenant → owner pairing code → enrol → setup wizard; suspend → till shows the suspended notice and keeps selling offline; reactivate. Shop admin on an admin device: create a code, enrol a second till, revoke it; a non-admin till cannot open Settings → Devices actions. The Worker refuses to start (throws on first request) if `ENV=test` while `ALLOWED_ORIGINS` contains `https://algovyn.com`, so the bypass can never reach production.
16. Udhaar refund split: bill paid Rs 1,000 cash + Rs 1,150 udhaar (R5) → refund the charger → Rs 1,000 cash out, khata −Rs 250; refund a cable → khata only, no drawer; day close shows only the Rs 1,000.
17. Return to supplier: record a delivery, return 3 items with Rs 550 cash back (S2) → supplier balance 0, stock −3, avg cost unchanged, day close D3 correct, supplier ledger and Activity show the return.
18. Barcode labels: generate a barcode for a product without one, print 3 labels at 50 × 25 mm (PDF page check), decode the rendered code with zxing-wasm, scan it on Sell → product added.
19. Tax-inclusive: owner sets tax 17% + Prices include tax → a Rs 11,700 sale totals Rs 11,700 with "Includes Sales tax 17%: Rs 1,700" on screen and receipt (T9); with tax 0 the switch is hidden.
20. Stale till: device context offline for a simulated 35 days (clock mocked, server prune run) → reconnect pushes, gets 410, snapshots, ends in sync.
21. **Two shops** (`e2e/isolation.spec.ts`, two browser contexts enrolled in shop-basic and shop-other): the same barcode scans to each shop's own product and price; Products, Sales, Udhaar, Reports and photos show only the own shop's rows after sync; the receipt shows the own shop's name and logo; a context that was enrolled in shop A and "left" it cannot read A's data after enrolling in B (Dexie database `bikri-<A>` deleted).
22. Quota: shop A's budget set to its usage so far → its sync badge shows "Daily sync limit reached" while it keeps selling; shop B keeps syncing.
23. Read-only: a till of shop A goes offline and makes 2 sales; the operator makes A read-only with a reason; the till reconnects → both sales reach the server, the read-only banner appears (EN and UR), Sell and Pay are blocked with the toast, Reports and Sales history still work, `Download full export` works, and Activity shows the status change with the reason; shop B keeps selling; reactivating removes the banner.
24. Owner email sign-in: on an admin device unlocked as owner, `Add a till` asks for the email code → the code read from the fake `EMAIL` binding signs in → the code is created; a wrong code 5 times kills it; Lock drops the session and the next action asks again; `Download from server` builds a zip whose row counts equal the server's.
25. Support access: the operator starts support access for shop A (2 h, reason) → every till of A shows the support banner with the reason, B shows none; the support browser profile enrols, sees A's reports, cannot save a sale; the owner presses `End now` → the support device gets `DEVICE_REVOKED` and the banner disappears; Activity shows start and end.

Visual snapshots: Playwright screenshots of every screen (light, dark, Urdu) stored in `e2e/__screenshots__`; diffs reviewed in PRs (threshold 0.2%).

## 6. Manual hardware checklist (before each release)

| # | Check | Pass when |
|---|---|---|
| H1 | The shop's USB ESC/POS printer (model chosen later; 80 mm recommended) on Windows Chrome/Edge via WebUSB, set up with the printer setup wizard | test print: 48 chars/line at 80 mm (32 at 58 mm), ruler not wrapped, logo crisp, Urdu line legible, cut works |
| H2 | Same printer via Web Serial (virtual COM port, if the vendor driver exposes one) | same |
| H3 | A 58 mm USB printer (or the same printer set to 58 mm) on Android Chrome via USB OTG | 32 chars/line, 384-dot raster |
| H4 | System print (`window.print`) to the same printer with its Windows driver, 58 mm and 80 mm CSS | no margins, single page, correct width |
| H5 | Cash drawer via printer RJ11 | opens on cash sale and F9, not on card sale |
| H6 | USB barcode scanner (keyboard mode, Enter suffix) | 20 fast scans → 20 increments, none lost |
| H7 | Phone camera scanning (zxing-wasm) | EAN-13 reads in < 1 s in shop lighting |
| H8 | Power cut test: unplug PC during payment | after reboot the sale is either fully saved or not at all; no half rows |
| H9 | 8-hour soak on the shop PC | memory budget (08 §7) |
| H10 | Urdu UI on a 1366×768 laptop | no clipped Nastaliq text |
| H11 | Restore drill ([09 §3.2](09-backups-and-ops.md#32-restore-a-nightly-backup-to-a-new-database)): restore last night's backup into `bikri-restore` | row counts equal `manifest.json`; drill DB deleted afterwards |
| H12 | Hotkeys in a normal Chrome tab and in the installed app window ([08 §6.1](08-ux-guidelines.md#61-hotkeys-and-the-browser)) | every documented binding or its alternative works |
| H13 | Barcode labels on the shop's label printer (50 × 25 mm) and on an A4 3 × 8 sheet ([screens/20](screens/20-barcode-labels.md)) | 20 of 20 scans succeed with the USB scanner; text readable; no label skipped or shifted |
| H14 | Tenant restore drill ([09 §3.4](09-backups-and-ops.md#34-restore-one-tenant)) on a scratch tenant: export → purge → import → new epoch | row counts equal the export; another tenant's counts unchanged; scratch tenant deleted afterwards |

Record results in `docs/releases/<version>-hardware.md`.

## 7. CI

`.github/workflows/ci.yml` on every PR: `pnpm biome ci`, `pnpm typecheck`, `pnpm test` (unit + integration + the isolation suite, §8), `pnpm build`, `pnpm e2e` (Chromium desktop + WebKit phone, sharded 2), bundle size check (08 §7), i18n key parity check, link check of `docs/` (all relative links and images resolve). Required to merge.

`deploy.yml` and the nightly `website-guard.yml` run `node tools/check-website.mjs` ([01 §5.5](01-architecture.md#55-release-gate-a-clean-algovyncom-decision-d-049)); `tools/check-website.test.mjs` covers it with saved HTML samples (a page with `cdn.tailwindcss.com` → fail; a page with `navigator.serviceWorker.register('/sw.js')` → fail; Google Fonts stylesheet only → warn; clean page → pass).

## 8. Cross-tenant isolation suite (mandatory)

Bikri is multi-tenant on one shared database ([13](13-multi-tenancy.md)), so leakage between shops is the most serious bug class. This suite is **required in CI on every PR** and part of the definition of done (AGENTS.md §5): any new endpoint, table, query, file path or export must extend it in the same PR.

Setup (`apps/api/test/isolation/setup.ts`): two tenants **A** and **B** from `shop-basic` and `shop-other`, with **colliding ids, SKUs, barcodes, invoice numbers and bill prefixes**, two devices each (one admin), plus a suspended tenant **S**, a tenant **D** in `deleting` and a read-only tenant **R** (one device that has already seen the status, one that has not). Each tenant has an `owner_email`; the `EMAIL` binding is a fake that records messages.

| # | Case | Expected |
|---|---|---|
| I1 | Pull and snapshot (every table) with B's token | only B rows; no row equals an A row; no `tenant_id` in any row; counts equal B's own |
| I2 | B pushes an upsert of a product whose id exists in A | B's row created/updated; A's row byte-identical afterwards |
| I3 | B pushes ledger rows referencing A-only ids (customer, sale, product, branch, staff, supplier, purchase line) | `rejected` / `FOREIGN_KEY` for each; nothing written |
| I4 | B pushes rows with `tenant_id: "<A>"` inside `row` | key ignored; rows land in B |
| I5 | Same `op_id` used by A and B | both applied (applied_ops keyed by tenant) |
| I6 | Same SKU / barcode / bill prefix / `INV-A-1` in A and B | all accepted; uniqueness still enforced inside each tenant |
| I7 | Files: B GETs A's relative key `products/<A id>/<sha>.webp` | `404` (B's prefix only); upload by B lands under `t/<B>/` |
| I8 | B's admin device: list/revoke/rename A's device id, import ops of A's revoked device, acknowledge A's conflict, cancel A's enrolment code | `404 NOT_FOUND` each; A unchanged |
| I9 | An enrolment code created by A | enrols into A only; response tenant = A |
| I10 | `/api/me` with each token | own tenant and device only |
| I11 | Error bodies for I3/I7/I8 | identical whether or not the id exists in A (no existence oracle) |
| I12 | Prune with old rows in A and B | per-tenant floors; B never gets `410` for A's pruned rows |
| I13 | New `restore_epoch` for A | only A's pull responses change |
| I14 | A over budget | A gets `TENANT_QUOTA`; B applied |
| I15 | S (suspended) and D (deleting) tokens | `403 TENANT_SUSPENDED` on every device endpoint |
| I16 | Tenant deletion cron for D | only D's rows and `t/<D>/` objects removed; A/B counts unchanged |
| I17 | Operator export of A | only A rows; an `operator_export` audit row in A only |
| I18 | Tenant restore of A (purge + import) | B unchanged throughout; B pushes during A's maintenance are applied |
| I19 | Static check: every statement built in `apps/api/src` (outside `platform/`) that touches a tenant table contains `tenant_id = ?1`; no `env.DB` use outside `db/tenantDb.ts` and `platform/` | test fails with the offending file and SQL |
| I21 | R (read-only): pull, snapshot, `/api/me`, file GET, enrol | work, only R rows; a push of new ops and a file PUT → `403 TENANT_READ_ONLY` (or ops omitted, per the cutoff); A and B pushes in the same minute applied; the `tenant_status_change` audit row exists in R only; `tenant_status` in A's and B's responses stays `active` |
| I22 | Owner server export (`GET /api/shop/export`) with B's admin device and owner session | only B rows, no `tenant_id`, no `token_hash`, no `owner_email_codes`; an `export_id` started by A is refused on B's device; A's export limit does not affect B; a non-admin device, a manager or a missing session → `403` / `401`; `owner_export` audit row in B only |
| I23 | Owner email sign-in | a code started on A's admin device is sent only to A's `owner_email`; verifying A's `code_id` from B's device → `400 BAD_SIGNIN_CODE` with the same body as an unknown id; A's owner session sent with B's device token → `401 OWNER_SIGNIN_REQUIRED`; B's sign-in limits are independent of A's |
| I24 | Operator support access to A | the support code enrols into A only; the support device sees only A rows, cannot push or upload (`403`), stops at `expires_at`; `support` is non-null only in A's `/api/me`; start and end audit rows in A only; B's owner cannot end A's support access (`404`) |
| I20 | Schema check: every tenant table has `tenant_id`, `PRIMARY KEY (tenant_id, id)` (or `(tenant_id, op_id)`), every FK to a tenant table is composite, every index starts with `tenant_id` (except `change_log_at`, `applied_ops_at` and the automatic indexes of the global `token_hash` / `code_hash` keys) — read from `sqlite_master` / `pragma_foreign_key_list` | test fails naming the table |

Till side (`apps/pos`, fake-indexeddb): the Dexie database name is `bikri-<tenant_id>`; "Leave this shop" deletes it; enrolling into a second tenant never opens the first tenant's database; exports contain only the active tenant.
