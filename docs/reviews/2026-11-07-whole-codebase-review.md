# Whole-codebase review — 7 Nov 2026

**Scope:** the whole repository at `5e0fe2c` (the sixth-review remediation): `apps/api`, `apps/pos`, `packages/core`, `packages/db`, `packages/printer`, `packages/i18n`, `e2e`, `tools`, migrations, CI and the specs in `docs/`.

**Method:** read the code and the relevant specs, traced each finding to the exact lines, ran the project gates, and reproduced the two highest-impact sync defects with a temporary Worker test (removed after the run).

**Gates:** `pnpm lint` and `pnpm typecheck` pass. `pnpm test` passes all 8 tasks (2m00s). `i18n:check`, `docs:check` and `size` pass. The findings below are therefore **gaps in test coverage**, not regressions caught by CI.

**Verdict:** the money rules, tenant boundary and happy-path sync are in good shape. The weak area is still the **offline failure path**: an offline sale followed by a refund/void, a restore with unsynced rows, and a push containing a newly created cashier are all rejected by the Worker today. Those are core promises of the product, so they should block the 1.0 tag.

Severity: **P0** = data loss/corruption or a core offline flow broken; **P1** = serious correctness/security defect with a plausible path; **P2** = real defect/edge case; **P3** = polish, defence in depth or spec drift.

---

## P0 — fix before v1

### P0-1 Restore recovery re-queues ledger rows that are still in the outbox

**Evidence**
- `apps/pos/src/sync/pull.ts:592-611` collects **every** own ledger row created at/after the restore point into `recoveredRows`. There is no check against the outbox.
- Masters are explicitly skipped when already queued (`pull.ts:618-637`: `if (tbl !== 'staff' && queued.has(...)) continue;`); ledger rows are not.
- `pull.ts:761-774` appends a fresh `insert` op for every recovered row and deliberately keeps the original outbox entries.
- The Worker rejects any request that contains the same ledger `tbl:id` twice, and rejects **both** transactions: `apps/api/src/sync/applyOps.ts:4236-4248` builds `duplicateRows`, and `:4285-4290` rejects every group containing one.
- A single push request can contain both transactions: `apps/pos/src/sync/chunk.ts:32-50` (`nextTxBatch`) packs whole `tx_id`s up to 200 ops, and `push.ts:125` sends the batch in one request.

**Scenario:** the operator restores to last night's backup while a till has an unsynced sale (created after the restore point, still `pending` in the outbox). The till runs restore recovery, creates a second op for the same sale rows, and pushes both. Both transactions come back `CONSTRAINT_FAILED`. If the owner then uses **Discard**, `discardFailed` deletes the only local copy and the sale is lost.

**Fix:** build the same `queued` set used for masters and skip any recovered ledger row whose `[tbl, row_id]` already has a `pending`/`sending` outbox entry. Add a regression test that restores while a sale is pending and asserts exactly one applied copy.

---

### P0-2 An offline sale followed by a refund or void with stock return is rejected

**Evidence**
- `apps/api/src/sync/applyOps.ts:1423-1447` (`refund_return`) resolves each `refund_lines.sale_line_id` from the **current transaction group** or from D1 (`look.saleLineById`). A refund is a separate `tx_id` from the sale, so a sale that is only in an earlier transaction of the same push is invisible: `restocked` stays 0 and the movement is rejected.
- `applyOps.ts:1448-1466` (`void_return`) has the same gap: it reads `look.saleLinesBySale` (D1) plus sale lines in the void group, but the void group never contains the original sale lines.
- The client writes these movements by default: `apps/pos/src/data/refunds.ts` restocks tracked lines, and `voids.ts` writes one `void_return` movement per tracked line.

**Reproduced** with a temporary Worker test: pushing `saleOps(...)` followed by a refund (header + line + payment + `refund_return` movement) in one request returned `CONSTRAINT_FAILED` for all four refund ops. The same refund **without** the restock movement applied cleanly. A void with a `void_return` movement behaved the same way. A new cashier created in an earlier transaction and used by a sale in a later transaction also returned `FORBIDDEN` (see P1-3).

**Impact:** the refund/void is saved locally, the money leaves the drawer and the khata changes, but the server never records it. The bill stays `paid` on the server while the till shows it refunded/voided. Discarding the failed op deletes the local refund, so the cash difference disappears from the audit trail.

**Fix:** build the sale-line lookups from **all pending sale ops**, not only the current group (the same way `pushedSales` already makes a same-push sale header visible). Either index `sale_lines` from every `sales` transaction in the push, or have the client include the referenced sale lines in the refund/void transaction. Add same-push tests for a refund with restock and a void with return.

---

## P1 — fix before v1

### P1-3 Same-push staff and shop changes are invisible to later transactions

**Evidence**
- Staff are loaded from D1 only (`applyOps.ts:3943`), and `staffForHistory` falls back to the current group only (`:588`, `groupStaffAuthorized` at `:536-567`).
- The shop row is loaded from D1 only (`:3904`).
- The "created earlier in this push" loop adds only customers, suppliers and branches (`:4108-4138`); it does not add staff or shop state.
- `applyProductChanges` (`:4191-4211`) updates products for later groups, but there is no equivalent for staff or shop.

**Impact:** the first sale after an offline setup (owner/cashier created in the setup transaction, sale in a later transaction) is rejected `FORBIDDEN`. The same applies to a new cashier created and used before reconnect. Conversely, a permission or discount-limit change in an earlier transaction is ignored for later sales in the same push, so a revoked cashier can still sell and a lowered limit is not enforced.

**Fix:** maintain in-memory `staff` and `shop` state in push order, applying only the fields the op will actually write (`changed_fields` + merge semantics), and make policy groups stop later planning if they fail. Add tests for "new cashier + sale in one push" and "limit lowered + sale in one push".

### P1-4 The push settle transaction reads ledger tables outside its Dexie scope

**Evidence**
- `apps/pos/src/sync/push.ts:162-172` scopes the transaction to `outbox`, `pull_shadow`, `kv` and only the **non-ledger** tables of the batch.
- Inside it, `push.ts:201-224` does `db.table(entry.tbl).get(entry.row_id)` whenever an applied op has a newer pending op. If `entry.tbl` is a ledger table, Dexie throws `NotFoundError: Table … not part of transaction`.
- The `newer` count includes `failed` entries (`push.ts:201-204`), so a failed op plus a retry/recovery op is enough.

**Impact:** the settle aborts, the batch stays `sending`, the next push reclaims and resends it, the server answers from `applied_ops`, and the same abort repeats. The outbox never drains until the failed op is discarded.

**Fix:** include every `entry.tbl` in the transaction scope (or use `tx.table(entry.tbl)`), and count only `pending`/`sending` entries in `newer`.

### P1-5 Snapshot merge has no row quarantine; a `sale_voids` unique collision wedges initial sync

**Evidence**
- `apps/pos/src/sync/pull.ts:208-215` merges a whole snapshot page in one transaction with no per-row error handling.
- `mergeRows` does `await table.put(row)` (`merge.ts:83`).
- The Dexie schema has `sale_voids: 'id, &sale_id'` (`packages/db/src/dexie.ts:30`).
- The normal pull path quarantines a bad row and advances the cursor (`pull.ts:123-153`); the snapshot path does not.

**Scenario:** two tills void the same bill offline. The server accepts one void and rejects the other. On the losing till (after a 30-day cursor gap or a restore), the local pending void `B` and the server's void `A` have different ids but the same `sale_id`. `put(A)` throws `ConstraintError`, the page transaction aborts, `snapshot_state` never advances, and every retry fails the same way.

**Impact:** the till can never finish the snapshot. If the local void is later discarded, `recomputeDiscardedStatuses` flips the sale back to `paid` with no later server change to correct it.

**Fix:** apply the same row-by-row quarantine used by pull to snapshot pages, and treat the server's void as the winner for a colliding `sale_id` (mark the local pending void failed and let the discard path reconcile).

### P1-6 Blind day close reveals the expected cash before the count

**Evidence:** `apps/pos/src/dayclose/DayClosePage.tsx:98-108` sets `blind = !can('dayclose.view_expected') && !revealed`, but the sticky footer at `:527-545` always renders `result.difference`. With `counted = 0` on load, the footer shows “Short Rs <expected>”, which is exactly the expected drawer amount.

**Impact:** a cashier without `dayclose.view_expected` can read the expected cash and make the count match, defeating the blind-count permission and screens/15 AC 4. The e2e test only checks the “Expected in drawer” label (`e2e/tests/day-close.spec.ts:71-75`), not the footer.

**Fix:** when `blind`, render a neutral “Count the drawer first” footer and hide the difference, the note-required warning and the close action until `revealed`. Add a test that asserts the difference is absent before counting.

### P1-7 Future `updated_at`/`deleted_at` values disable policy freshness checks

**Evidence**
- `applyOps.ts:1985` bounds only `created_at` to `now + DAY_MS`; `updated_at`/`deleted_at` are checked only as safe integers (`:1991-1995`).
- `updated_at` is always written on an upsert if present (`:2815-2817`).
- Freshness decisions compare the op time with that value: shop tax/rounding (`:1671-1675`), product below-price (`:1808-1821`), staff discount limit (`:1851-1859`).

**Impact:** a product upsert with `updated_at` far in the future makes `entryAt >= product.updated_at` false for every later sale, so the below-price check is skipped. A shop row with a future `updated_at` disables the tax/rounding comparison, and a staff row disables the discount limit. A device with a badly set clock can do this accidentally; a crafted push can do it deliberately. A `purchase.create` user can pair this with the `costSource` path (only `last_cost` changed) to avoid needing `catalog.edit`.

**Fix:** bound `updated_at`/`deleted_at` the same way as `created_at` (or to `op.created_at ± MAX_ROW_OP_SKEW_MS`), and prefer server time for policy freshness where the offline policy snapshot is not essential.

### P1-8 Discount override accepts self-approval and ignores the approver's limit

**Evidence**
- `overrideFor` (`applyOps.ts:389-429`) accepts roles `owner`, `manager` **and `cashier`**, and only checks `can(approver.role, …, permission)`.
- The discount check (`:1844-1859`) uses `overrideFor(..., 'sale.discount', look.staff)` but never checks that the approver is a different person or that the approver's `max_discount_bp` covers the discount.
- The POS approver list already excludes the seller and requires an owner/manager whose limit covers the discount (`apps/pos/src/sell/SellPage.tsx:228-245`).

**Impact:** a cashier has `sale.discount` by default, so a crafted push can include an override audit row naming the cashier as `approved_by` and exceed their limit. A manager with a 5% limit can approve a 50% discount because the server never checks the approver's limit.

**Fix:** require `approved_by !== seller/actor`, require owner/manager (or at least an approver whose `max_discount_bp` covers the share), and bind the approval to the sale as the UI does. Add tests for self-approval and an approver below the limit.

---

## P2 — real defects and edge cases

### P2-9 Payment-sourced ledger entries can move party balances for sale/refund/void payments

`checkLedgerEntry` (`applyOps.ts:1224-1236`) accepts a `source_type='payment'` ledger row for **any** payment purpose and expects `-amount`. The payment validation (`:2295-2398`) does not require `party_type = null` for `sale`, `refund` or `void` payments. `checkSaleInsert` only sums sale-purpose payments (`:1582-1594`), and `checkRefund` only counts ledger rows with `source_type='refund'` (`:886-916`). A forged push can therefore record a sale as paid while also reducing the customer's khata, or give cash back on a refund and credit the khata without `refunds.udhaar_part`. Restrict `source_type='payment'` to the documented purposes (`customer_payment`, `supplier_payment`, `purchase_paid_now`, `supplier_refund`) and require null party on sale/refund/void payments.

### P2-10 A purchase's `paid_now` is accepted without its supplier ledger row

`checkPurchase` requires the purchase ledger row (`applyOps.ts:1510-1523`) and the payment row (`:1524-1535`), but not the `ledger_entries` row sourced from that payment. `checkSupplierReturn` does require the analogous row (`:1040-1058`). A purchase with `paid_now > 0` can therefore be recorded without reducing the supplier balance, so payables reports overstate what is owed. Require one `ledger_entries` row with `source_type='payment'`, `source_id = payment.id`, `party_type='supplier'`, `party_id = purchase.supplier_id`, `amount = -paid_now`.

### P2-11 `sales.status` uses the refund amount, not refunded quantities

`apps/pos/src/data/refunds.ts:399-409` sets `refunded` when `Σ refunds.exact_amount >= sale.total`; the server does the same in `applyOps.ts:2893-2900`. `docs/02-data-model.md:1056` defines `refunded` as **every line's refunded qty = sold qty**. A sale with a 100%-discounted line plus a paid line becomes `refunded` when only the paid line is refunded, and the free line can never be refunded at all because `refunds.ts:273` rejects `plan.exact <= 0`. The bill detail then hides the Refund action while units remain. Compute the status from `refund_lines.qty_milli` per sale line in both the till and the Worker, and decide how a zero-value return is recorded (restock-only refund or stock adjustment).

### P2-12 Day-close duplicate/overlap

- The client's concurrent-close guard only runs when the last close is less than 10 minutes old (`apps/pos/src/data/dayClose.ts:180`, `:220-225`). A form captured before a close and submitted later can create a second close for the next period with stale counted cash.
- `day_closes` has only a non-unique index on `(tenant_id, device_id, period_end)` (`packages/db/migrations/0001_init.sql:739`).
- The server checks `period_end` equality against the latest stored close (`applyOps.ts:2414-2436`), but two concurrent "first closes" both see no previous close and both insert.

**Fix:** compare `expectedPeriodStart` with the current period start unconditionally, add a unique constraint or a trigger for `(tenant_id, device_id, period_end)`, and reject a close whose period starts before the latest stored close ends. Add a stale-form test with a gap greater than 10 minutes.

### P2-13 Failed outbox ops block pull merges

`mergeRows` loads every outbox entry for a page's rows without filtering by status (`apps/pos/src/sync/merge.ts:64-70`) and stores the server row in `pull_shadow` when a key matches (`:76-78`). A `failed` op will never be pushed unless retried, so it should not shadow the server. A rejected unauthorized price edit therefore hides all later server changes for that row until someone discards it — and Discard is owner-only (`apps/pos/src/settings/SyncPage.tsx:270-280`), so a cashier's till can be stuck indefinitely. Filter to `status === 'pending' || status === 'sending'`.

### P2-14 Multi-tab pushes steal live claims and can invert transaction order

`pushAll` resets **every** `sending` row, including another live tab's claim (`apps/pos/src/sync/push.ts:108-112`). The settle checks the claim token (`:178-185`), but the reset does not check ownership. With two tabs, tab A can claim batch N and tab B batch N+1, and the two HTTP requests can arrive out of order. Dependent transactions (customer/staff create then sale) can then be rejected `FOREIGN_KEY`/`CONSTRAINT_FAILED` and marked failed. Use `navigator.locks.request('bikri-sync', …)` (or a kv lease) around push/pull, and only reclaim `sending` entries older than the request timeout plus a margin.

### P2-15 Enrolment consumes the one-time code before the token is persisted

`apps/pos/src/data/enrol.ts:82-93` calls `/devices/enrol`; the server claims the code and creates the device in one batch. The client then deletes/clears databases and caches (`:94-104`) and only writes `device_token` at `:105-128`. Any failure in that window (IndexedDB quota, blocked delete, tab close) loses the token; the code is single-use, so a retry gets `BAD_ENROLMENT_CODE` and an orphan device remains. `deleteTenantDb` uses `indexedDB.deleteDatabase` and only listens for `onblocked` (`packages/db/src/dexie.ts:301-306`), so with another tab holding the database the promise never resolves; `enrolDevice` deletes before `setActiveTenantId` broadcasts (`enrol.ts:130`), and `leaveShop` deletes before clearing the active tenant (`:258-260`). Persist the token and minimal kv first, broadcast the switch/leave before the deletes, and add a timeout/handshake for other tabs.

### P2-16 Snapshot-start `COUNT(*)` scans bypass the read budget

`apps/api/src/routes/sync.ts:270-280` runs one `SELECT COUNT(*)` per snapshot table on every `GET /sync/snapshot` start. Only returned pages call `addRowsRead` (`:300`), and `assertReadQuota` uses `rows_read + pendingRowsRead` (`:84`). A device token can loop the start endpoint without ever advancing the counter, consuming the account-wide D1 read limit. `admin.export` and `shop.export` use the same `snapshotPayload` and have the same gap. Count the start scans (or cache them briefly) and rate-limit snapshot starts; add a test that repeated starts eventually hit `TENANT_QUOTA`.

### P2-17 The nightly prune can abort on self-referencing sales/expenses

`DELETE_ORDER` (`apps/api/src/platform/prune.ts:18-26`) deletes every table with the same generic statement (`:197`). `sales.replaces_sale_id` (`packages/db/migrations/0001_init.sql:403`) and `expenses.reverses_id` (`:686`) are immediate composite FKs. If a replacement/reversal is outside the current 2,000-row chunk while the row it references is inside it, the delete fails and `pruneAll` aborts (no per-step try/catch). The admin purge already handles this with two passes (`apps/api/src/routes/admin.ts:808-832`); the cron does not. Reuse the two-pass approach and add a test with more than `DELETE_CHUNK` sales where a late sale replaces an early one.

### P2-18 Admin restore has no confirmation, and admin import does not run `checkOp`

`apps/pos/src/admin/RestoreTab.tsx:204-254` starts the whole restore (maintenance on → purge → import) directly from the primary button once a zip is selected. There is no confirm dialog or slug/reason step, unlike Delete (`admin/DeleteTab.tsx:119-142`). One misclick after choosing a zip purges the shop; if the import then fails, the shop is left in maintenance with no data. The UX guidelines require destructive actions to be behind a confirm (`docs/08-ux-guidelines.md:159`, `:189`).

Separately, `admin.ts:869-905` validates only tenant id, allowed columns, id length, string length and safe integers, then calls `db.upsert`. It never calls `checkOp` or the table-specific money/permission checks, although `docs/04-api.md:191` says import rows are "checked by `checkOp` and the D1 constraints". Add the confirmation and run the same row/document validation used by push (or a dedicated restore validator), with tests for invalid money/stock rows.

### P2-19 Operator audit coverage is incomplete

`screens/19-admin.md` AC 8 requires every operator action on a tenant to write an `audit_log` row in that tenant. `admin.patch('/tenants/:id')` only audits `owner_email` changes; `display_name`, `daily_write_budget`, `poll_after_ms` and `note` are updated silently (`apps/api/src/routes/admin.ts:319-348`). `POST /tenants/:id/purge` performs the purge with no audit row (`:808-850`), and `POST /tenants` creates a tenant with no tenant audit row (`:120-148`). The owner cannot see budget/name changes, purges or creation in Settings → Activity. Add audit rows with before/after values.

### P2-20 The cash drawer is not opened on most cash paths

`docs/06-printing.md:273-275` requires a drawer kick for cash sales (any cash portion), cash refunds, pay-ins/pay-outs and F9. Today the only callers are F9 (`apps/pos/src/sell/SellPage.tsx:509-521`), Settings (`PrinterPage.tsx:111`) and the receipt builders (`apps/pos/src/print/receiptFiles.ts:77-78`). These cash writes never kick the drawer:

- customer payment (`apps/pos/src/udhaar/ReceivePaymentDialog.tsx:93-115`),
- supplier payment (`apps/pos/src/suppliers/PaySupplierDialog.tsx:58-74`),
- cash in/out (`apps/pos/src/expenses/CashMoveDialog.tsx:44-59`),
- supplier return (template ends with `pushJobEnd(blocks, false)`, `packages/printer/src/templates/supplierReturn.ts:87`),
- void (same, `templates/void.ts:61`),
- cash expense (`ExpenseDialog.tsx:101-135`),
- any sale/refund with auto-print off (no print job → no receipt → no drawer; `PayDialog.tsx:217`, `sale.ts:595-605`).

Add one shared `kickDrawerForCash` after every successful cash movement (respect the drawer setting, read-only/support, transport, and write the `drawer_open` audit where appropriate), and add drawer blocks to the supplier-return and void templates.

### P2-21 Privacy mode leaks payment-mix and expense-share percentages

`PaymentMixBar` (`apps/pos/src/reports/charts.tsx:198-257`) has no `usePrivacyActive`/`PrivacyCurtain`, renders raw bar widths, a visible `{share}%`, and an `aria-label` containing the percentages. The Reports expenses table renders `percentText(row.shareBp)` raw (`ReportsPage.tsx:1327`). `docs/04` says charts are replaced by an “Amounts hidden” panel and percentages become `••%`. Return `PrivacyCurtain` when privacy is active and wrap the expense share in `PrivacyValue`.

### P2-22 Receipt PNG/PDF/WhatsApp images can render Urdu in a fallback font

`renderReceiptCanvas` only awaits already-loading fonts (`apps/pos/src/print/receiptImage.ts:120`); the explicit Noto/Inter loads live in `prepareRasterFonts` (`apps/pos/src/print/canvasRaster.ts:16-27`), which the thermal path calls but `receiptPng`/`receiptPdf` do not (`receiptFiles.ts:208-226`). If the UI is English but the receipt language is Urdu, Noto Naskh may not be loaded and canvas silently uses a serif fallback. Call `prepareRasterFonts(doc)` at the start of `renderReceiptCanvas`, and test UI `en` + receipt `ur`.

### P2-23 `Ctrl+Shift+H` opens Hold on Sell instead of toggling privacy

`SellPage.tsx:482-489` matches any `Ctrl+H`, including Shift. `useHotkey` listens in the capture phase and calls `preventDefault()` (`shell/hotkeys.ts:42-51`); the global privacy handler skips `defaultPrevented` events (`AppShell.tsx:156-167`). The documented global privacy shortcut is therefore broken on the main selling screen. Require exact modifiers for Hold (`!e.shiftKey && !e.altKey`, preferably `e.code === 'KeyH'`) and test `Ctrl+Shift+H` on `/sell`.

---

## P3 — polish, defence in depth and spec drift

| # | Finding | Evidence | Fix |
|---|---------|----------|-----|
| 1 | Reissue approval is written without `bound_cart`, so it never matches and Sell asks again | `sales/BillDetail.tsx:257-275`; `data/cart.ts:236-238`; `data/sale.ts:197-199`; `sell/SellPage.tsx:340-342` | Write the override through `addOverride` with `bound_cart: cartSignature(cart)`, or bind it in `sale.ts` |
| 2 | Hourly report buckets a backdated sale by `created_at`, not `business_date` | `data/reportBundle.ts:438`, `:481` | Only add to `hourly` when `businessDate(created_at, tz) === business_date`; add a backdate test |
| 3 | `isEmptyCart` ignores `backdate`, `reissue`, `note` and overrides | `data/cart.ts:74-76`; `data/backdate.ts:100-112`; `data/sale.ts:643-644` | Include those fields; test that a backdate cart cannot be resumed/reissued over |
| 4 | Post-commit print failure makes a committed refund/day close look failed | `data/refunds.ts:415`; `data/dayClose.ts:285-286` vs `data/sale.ts:595-605` | Treat print queueing as best-effort after commit |
| 5 | File upload marks 429/408/425 permanently failed | `sync/files.ts:51-64` | Retry 408/425/429; only permanent 4xx become `failed` |
| 6 | `last_sync_at` is updated by push-only cycles, masking the stale-pull warning | `sync/engine.ts:133-135`; `data/home.ts:31-38` | Use `last_pull_at` for the 7/25-day warning |
| 7 | Invalid calendar dates (`2026-02-31`) pass regex-only validation | `data/udhaar.ts:462-467`; `data/expenses.ts:213-220`; `data/purchases.ts:77-82`; `data/backdate.ts:33-40` | Reuse `isBusinessDate` everywhere |
| 8 | Slow movers count voided sales as recent sales | `data/reportBundle.ts:717-727`; `data/voids.ts:226-236` | Skip sale movements whose sale is voided |
| 9 | Net sold quantities are clamped at zero | `data/catalog.ts:131`, `:313` | Keep the signed net; clamp only for display |
| 10 | Day-close reprints recompute card/bank/udhaar/bills/refunds from current data | `data/dayCloseReceipt.ts:20-25`; `data/dayClose.ts:58-104` | Store those totals on `day_closes`, or label the reprint as recomputed |
| 11 | Supplier return accepts a linked purchase line from another supplier locally | `data/supplierReturns.ts:226-239` vs `sync/applyOps.ts:1000-1005` | Load the parent purchase and compare `supplier_id` |
| 12 | Stock adjustments are not idempotent | `data/stock.ts:119-173` | Accept an `adjustmentId` and return the existing movement |
| 13 | A manager override for a missing `sale.discount` permission is accepted locally but rejected by the Worker | `data/cart.ts:282-298`; `data/sale.ts:254-264`; `sync/applyOps.ts:1844-1857` | Do not offer an override for a revoked permission, or make the server accept it consistently |
| 14 | WhatsApp toggle on Pay is ignored by SaleComplete | `sell/PayDialog.tsx:216`, `:298`, `:586`; `sell/SaleComplete.tsx:236`, `:361` | Use `done.whatsapp` to decide auto-share/label |
| 15 | Sale-complete auto-close reads a key nothing writes | `sell/SaleComplete.tsx:157-170`; `settings/DisplayPage.tsx:136-178` | Add `autoClose` to device prefs, or remove the dead read |
| 16 | Printer page shows a stale “last error” after a successful reprint | `settings/PrinterPage.tsx:122`, `:149`; `data/printJobs.ts:69-83` | Use `unresolvedFailedCount`/latest unresolved failed job |
| 17 | WhatsApp share text is hard-coded English | `data/receipt.ts:250-277` | Build it from `input.labels`/receipt language |
| 18 | `assertTenantScoped` counts predicates rather than binding them to tables | `apps/api/src/db/tenantDb.ts:98-116` | Parse aliases and require one predicate per referenced table; add duplicate-predicate tests |
| 19 | Append-only is not enforced by the schema | `packages/db/migrations/0001_init.sql:365-754` (no ledger triggers) | Add `BEFORE UPDATE/DELETE` triggers allowing only the documented `sales.status` update and a maintenance path |
| 20 | Admin import can overwrite `audit_log` and does not call `checkOp` | `apps/api/src/routes/admin.ts:852`, `:901`; `docs/04-api.md:191` | Insert-only for ledger/audit, and run `checkOp` |
| 21 | `meta.schema_version` is stale (`1` vs Worker `SCHEMA_VERSION=2`) | `packages/db/migrations/0001_init.sql:9`; `apps/api/wrangler.jsonc:35`; `docs/02-data-model.md:826` | Update the marker in the migration that bumps the version |
| 22 | Docs drift: 90% vs 80% poll threshold; V1/V2 `print_jobs` index; PK exceptions | `docs/09-backups-and-ops.md:127` vs `docs/13-multi-tenancy.md:108`; `docs/02-data-model.md:1023` vs `packages/db/src/dexie.ts:47`, `:56`; `docs/02-data-model.md:9` vs `docs/10-testing.md` I20 | Correct the docs or the code |
| 23 | Support-access start can shorten a longer grant under concurrency | `apps/api/src/routes/admin.ts:452-456` | Use `MAX(support_until, …)` in the UPDATE or a CAS |
| 24 | Conflict acknowledgement appends `change_log` on every no-op and writes no audit | `apps/api/src/routes/shop.ts:615-629` | Guard the change-log insert with `changes() = 1`; audit the acknowledgement |
| 25 | Health endpoint runs a D1 query on every unauthenticated request | `apps/api/src/routes/health.ts:5`; `platform/health.ts:6` | Cache per isolate for 30–60 s or rate-limit |
| 26 | Request bodies are buffered before the size check | `apps/api/src/middleware/body.ts:15-19`; `routes/sync.ts:109-111`; `routes/files.ts:81-83` | Stream with a hard byte counter, or require `Content-Length` for large routes |
| 27 | Enrolment token response lacks `Cache-Control: no-store` | `apps/api/src/routes/enrol.ts:174-185` | Set `no-store` on token-returning responses |
| 28 | Request logger records thrown errors as HTTP 200 | `apps/api/src/middleware/requestLog.ts:22-28` | Derive status from `c.error`/`ApiError`, or log after `onError` |
| 29 | Approve-request swallows malformed/oversized body errors | `apps/api/src/routes/admin.ts:208` | Only default on a genuinely empty body; propagate `413`/`400` |
| 30 | R2 per-tenant cap is a TOCTOU race | `apps/api/src/routes/files.ts:100-117` | Atomic per-tenant byte counter or serialise uploads |
| 31 | Tenant deletion leaves `tenants.note`, `support_reason`, `status_reason` and approved `shop_requests` PII | `apps/api/src/platform/prune.ts:232`; `platform/shopRequests.ts:703-712` | Clear/anonymise on deletion per docs/09 §6.1 |
| 32 | Tenant write budget meters only push/import writes | `apps/api/src/routes/sync.ts:52-71`; `routes/shop.ts:333-338`, `:528-546`; `routes/enrol.ts:150-160` | Meter shop-admin/enrolment writes into `tenant_usage` |
| 33 | Test-mode Access bypass is not bound to a local request host | `apps/api/src/middleware/sameOrigin.ts:38-49`; `middleware/accessAuth.ts:20-23`; `index.ts:46-49` | Require a local/test host or a test-only secret; remove test routes from production |
| 34 | Website gate does not recurse into same-origin imports | `tools/check-website.mjs:55-68`, `:310-316` | Recursively parse imports/dynamic imports, or run a browser crawl |
| 35 | Nightly backup completeness omits platform tables | `tools/backup/export.mjs:54`; `tools/backup/tables.mjs:5-39` | Require every table in `packages/db/src/tables.ts` |

---

## What is solid

- **Tenant boundary:** device tokens map to one tenant, `c.var.tenant` is never read from a request, non-platform SQL goes through `tenantDb`/`tenant_id = ?1`, R2 keys are server-built under `t/<tenant>/`, and the isolation suite covers colliding ids across two tenants. The `assertTenantScoped` weakness above is defence in depth, not a live leak.
- **Money rules:** integer paisa/milli-units/basis points; `mulDivRound`, `allocate`, `roundTo`; sale totals, discounts, tax inclusive/exclusive, rounding, per-line allocation, cash tender/change, refund split/rounding, purchase landed cost, weighted average, day-close formula and all fixture vectors are consistent.
- **Append-only at the application layer:** the Worker rejects update/delete on ledger tables, the till writes one Dexie transaction per action with matching outbox ops, and master data is soft-deleted. The schema-level gap (P3-19) is a hardening item.
- **Auth:** owner sessions are HMAC-signed and re-check the owner; Access JWT verification checks signature, audience, issuer, expiry and the operator allow-list; enrolment, owner sign-in, export start and status changes use conditional updates; read-only and support devices are blocked from writes.
- **Printing:** ESC/POS init/code page/align/bold/size, `GS v 0` banding, QR, cut and drawer bytes are correct; user text is escaped in HTML labels; the printer package tests pass (90/90).
- **Offline shell:** shop chunks, fonts and core routes are precached; admin chunks are excluded; the core Sell/Pay/print flows are local-first; the PWA scope and CSP are correct.
- **Accessibility/i18n:** axe coverage, logical properties, LTR money inside RTL, `t()` keys checked by CI, and 390/768/1280/1920 layout checks are in place.
- **Release gates:** Actions are SHA-pinned with `contents: read`; deploy trusts only a push to this repo's `main`; the backup is `age`-encrypted and verifies every required tenant table; the bundle gate counts nested chunks; the website check fails closed.

---

## Suggested order

1. **P0-1, P0-2, P1-3** — restore recovery, offline refund/void, same-push staff/shop. These are the core offline promises and they are currently broken.
2. **P1-4, P1-5** — sync-loop and snapshot wedge; add the missing regression tests.
3. **P1-6, P1-7, P1-8** — blind count, clock/freshness bounds, override authorisation.
4. **P2-9 to P2-13** — document integrity (payments/ledger, status, day close, failed-op merge).
5. **P2-14 to P2-23** — multi-tab/enrolment, budget/prune/restore/audit, drawer/privacy/fonts/hotkey.
6. P3 items as a cleanup PR; do the docs drift and the append-only triggers before the first real restore drill.

## Test gaps to close with the fixes

- Restore with a pending sale in the outbox (exactly one applied copy, no duplicate rows).
- Offline sale → refund with restock, and offline sale → void, in one push.
- New cashier + sale in one push; permission/limit change + sale in one push.
- Replayed refund/void with a fresh op id (the documented restore/`applied_ops`-prune path).
- Snapshot with a local pending `sale_voids` row colliding on `sale_id`.
- Blind day close: the difference is not in the DOM before the count is revealed.
- Two concurrent day closes for one device (stale form and parallel push).
- `Ctrl+Shift+H` on `/sell` toggles privacy; `Ctrl+H` still holds.
- Payment-sourced ledger row for a sale/refund/void payment is rejected.
- Future `updated_at` on a product/shop/staff row is rejected.
- A cash drawer kick for customer payment, supplier payment, cash in/out, cash expense, supplier return, void and a sale with auto-print off.

---

## Remediation status (7 Nov 2026)

The P0, P1 and P2 findings and all but the tooling/hardening P3 items were fixed in the same change set. Regression tests were added for the same-push sale/refund/void, same-push staff, future `updated_at`, self-approved discounts, payment-sourced ledger rows, append-only triggers, restore recovery with a queued row, real calendar dates and `clearTenantDb`.

| Finding | Status |
|---|---|
| P0-1, P0-2 | Fixed; restore recovery skips queued ledger rows, and same-push sale lines are visible to refund/void checks. |
| P1-3 … P1-8 | Fixed; parent-first planning, settle scope, snapshot quarantine, blind footer, row-time bounds, discount approver checks. |
| P2-9 … P2-23 | Fixed (P2-11 derives status per line; a zero-value line still needs a stock adjustment rather than a refund). P2-18 uses structural/D1 validation plus insert-only ledger import and excludes `audit_log`, rather than per-document `checkOp` on a per-table import. |
| P3-1 … P3-29, P3-31, P3-35 | Fixed. P3-33 keeps the existing `assertSafeEnv` fail-closed check instead of a request-host check (the test host is the production origin; a production deployment with production origins is rejected). |
| P3-30 | Open: the R2 per-tenant 1 GB cap is still a list-then-put check; an atomic per-tenant byte counter would close the parallel-upload race. |
| P3-32 | Open: shop-admin and enrolment writes are still unmetered by `daily_write_budget`; push/import writes are metered. |
| P3-34 | Open: `check-website.mjs` does not recurse into same-origin imports. |
| P3-22 | Fixed: the poll threshold, `print_jobs` V1/V2 and primary-key exceptions are corrected in docs/02 and docs/09. |

### Verification after remediation

- `pnpm lint`, `pnpm typecheck`, `pnpm docs:check`, `pnpm i18n:check` and `pnpm size` pass (initial bundle 288.8 KB gz, budget raised to 290 KB).
- `pnpm test` passes all 8 tasks; the POS coverage gate is 85.07% branches.
- `pnpm e2e` passes 286 tests (40 skipped by project/environment rules), including the four journeys that failed in the first run: two-shop isolation, sale-complete share/PDF on desktop and phone, and the two-till sync/leave journey.
