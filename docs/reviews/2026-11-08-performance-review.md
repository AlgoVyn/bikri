# Performance review — 8 Nov 2026

**Scope:** the whole repository at `24f88d8` — `apps/api`, `apps/pos`, `packages/core`, `packages/db`, `packages/printer`, `packages/i18n`, `e2e`, `tools`, migrations, CI and the performance budgets in the specs.

**Method:** read the specs first (especially [08 §7](../08-ux-guidelines.md#7-performance-budgets), [11 T-062](../11-roadmap.md), [13 §6](../13-multi-tenancy.md#6-free-tier-budget-per-shop)), then traced every hot read/write path in the code. To avoid guessing, I seeded the documented reference dataset in temporary benchmarks and measured the real data-layer functions; the temporary tests were removed after the run. I also built the PWA, ran the bundle gate, ran `apps/api/test/perf.test.ts`, and used the real migrations to inspect D1 query plans.

**Gates run for this review:** `pnpm --filter @bikri/pos build` (pass), `pnpm size` (pass, 288.0 KB / 290 KB), `apps/api/test/perf.test.ts` (pass), `node tools/perf/measure-d1.mjs` (20,000 bills). The full unit/e2e suite was **not** rerun; this review is about cost and latency, not a regression gate.

**Reference data:** 1,000 products, 500 customers, 20,000 bills over 120 days (≈5,000 bills in the last 30 days), the same shape as `e2e/fixtures/large.json` and [10 §4](../10-testing.md#4-fixtures). Benchmarks used Node 26 + `fake-indexeddb`, so absolute milliseconds are not production numbers; they are directionally useful and the algorithmic findings are independent of the runtime.

**Remediation (same day):** the findings below were fixed in D-185 (catalogue/sold cache, session search index, print-job queries, D1 close indexes, narrow write scopes, incremental ledger cache, cached `Intl` formatters, lazy routes, paged lists, ZIP single allocation and a worker for spreadsheet parsing). After the changes the same benchmark measured `soldByProduct` 136 ms, `listProducts` 111 ms, 30-day `summary` 131 ms, an exact invoice search 41 ms and `unresolvedFailedCount` 4 ms (20,000 jobs). Report bundles deliberately keep the full-scan-above-200 rule from D-119: the 20k-bill report test regressed badly with chunked `anyOf` lookups.

---

## Verdict

The **server write path is in good shape**: per-push batching, a 40-call budget, tenant-scoped statements, and the D1 indexes for the hot pull/push/snapshot queries are all sensible. The T-062 row and byte measurements also hold up (1,961 bytes/bill, ≈155 MB/shop-year, matching [13 §6](../13-multi-tenancy.md#6-free-tier-budget-per-shop)).

The **till read path is the weak point**. Search is implemented as “query IndexedDB again on every keystroke”, and several list queries do an N+1 of one IndexedDB query per sale. At the documented reference size, two functions alone miss the product’s own budgets by an order of magnitude:

- Sell needs 400 ms from PIN to usable; `listProducts()` takes **1.2–2.1 s** at 5,000 bills, mostly because `soldByProduct()` runs one `sale_lines` query per sale.
- Search needs <50 ms per keystroke; global search takes **0.24–0.47 s per keystroke** at 20,000 bills, and the Products screen re-runs the 1.2 s query on every keystroke.
- The shell also loads **all print jobs** several times per printed sale (`unresolvedFailedCount`, `latestSaleJob`), which grows without bound.
- The day-close push reads **every payment and expense of the shop** because the close queries have no selective index — confirmed with `EXPLAIN QUERY PLAN` on the real migrations.

None of these are data-loss bugs. They are the difference between “works on a demo shop” and “stays fast in year two”, and the most important ones should block the 1.0 performance sign-off.

**One-line direction:** make reads index-driven and incremental, not query-per-keystroke; the writes can stay as they are.

---

## Priority fixes

| Priority | Finding | Evidence | Measured impact |
|---|---|---|---|
| **P0** | Sell/catalogue load runs one `sale_lines` query per sale in the last 30 days | `apps/pos/src/data/catalog.ts:85-106`, `:173`; `apps/pos/src/sell/useSell.ts:18`; `apps/pos/src/products/ProductList.tsx:79-87` | **1.2–2.1 s** for `listProducts`; 1.16–1.86 s of it is `soldByProduct` at 5,000 bills. Re-runs after every sale because the live query reads `sales`/`sale_lines`. |
| **P0** | Every keystroke re-queries the database; no in-memory index, no `useDeferredValue` | `apps/pos/src/shell/GlobalSearch.tsx:28-36`; `apps/pos/src/data/search.ts:13-70`; `ProductList.tsx:79-87`; [08 §7](../08-ux-guidelines.md#7-performance-budgets) | Global search **239–470 ms** per keystroke at 20,000 bills; Products **≈1.4 s** per keystroke. Budget is 50 ms. |
| **P1** | Print status loads every print job ever | `apps/pos/src/data/printJobs.ts:93-94`; `apps/pos/src/data/receipt.ts:226-239`; `apps/pos/src/shell/TopBarParts.tsx:280`; `apps/pos/src/data/home.ts:100` | **≈100 ms** per call at 20,000 jobs. `PrinterDot` re-runs on every print status change (queue → printing → done), so this cost repeats after every printed receipt. The `sale_id` index exists but is not used. |
| **P1** | Day-close push scans all payments/expenses/cash moves of the tenant | `apps/api/src/sync/applyOps.ts:3958-3980`; migrations `0001_init.sql:471-473`, `:691`, `:693-707` | `EXPLAIN` shows `payments`/`expenses`/`cash_moves` searched on the **tenant prefix only**. A year-old shop scans tens of thousands of rows per close, in every close push. |
| **P1** | Every write locks all stores; a credit sale rescans the customer's whole ledger inside that transaction | `apps/pos/src/data/write.ts:293`; `apps/pos/src/data/caches.ts:38-73`; `apps/pos/src/data/sale.ts:300`, `:498`; `packages/core/src/money/ledger.ts:30-37` | Sale commit cost grows with ledger history (read + sort every entry for the party) while holding a read-write transaction over `db.tables`. Risks the 150 ms sale-save budget and blocks live queries. |
| **P1** | Reports fall back to full-table scans; slow movers loads every stock movement up to today | `apps/pos/src/data/reportBundle.ts:260-290`, `:737-742` | A 30-day range has >200 sale ids, so `byAnyOf` loads all sale lines, payments, movements; slow movers ignores the report range. Worker keeps the UI alive, but report latency and memory grow unbounded. |
| **P1** | Bundle is at 288.0 KB of a 290 KB budget, with 93 initial JS requests (91 module preloads) and heavy routes statically imported | `apps/pos/vite.config.ts:40`; `apps/pos/src/routes/sell.tsx`, `products/new.tsx`, `products/index.tsx`, `stock/count.tsx`; `pnpm size` output | Only 2 KB of headroom. Initial graph includes Sell, Products list/detail/form and Stock count; all statically imported route modules are evaluated before the PIN screen. |
| **P2** | Product form loads all products to check an exact duplicate name, once per name keystroke | `apps/pos/src/products/ProductForm.tsx:161-171` | At 5,000 products this is 5,000 rows per character; typing a product name stutters. |
| **P2** | Product detail reads all historical sale lines and matches refunds per line | `apps/pos/src/data/catalog.ts:222-335` | 14-day chart loads the product's entire sale history, then does a filter per sale line. Fine today, grows with age. |
| **P2** | Other list/search paths repeat the same “reload everything” pattern | `apps/pos/src/data/udhaar.ts:608-621`; `apps/pos/src/data/suppliers.ts:83-106`; `apps/pos/src/data/customers.ts:46-78`; `apps/pos/src/data/udhaar.ts:137-225` | `refreshPromises` does one ledger query per open promise; supplier list loads all purchases per keystroke; customer search loads all customers and balances per keystroke. |
| **P2** | `Intl` formatters and `localeCompare` constructed per row/cell | `packages/core/src/dates.ts:2-13`; `apps/pos/src/lib/date.ts:16-55`; `packages/core/src/moneyFormat.ts:54-57`; `SalesList.tsx:553`; `ActivityPage.tsx:192` | Creating a `DateTimeFormat` is **0.106 ms** vs 0.008 ms cached; a 50-row Sales render creates ~100 formatters. Low-end Android is several times slower. |
| **P2** | Whole-shop export materialises every table, JSON + CSV, then a STORE zip in memory; CRC is a JS byte loop | `apps/pos/src/data/shopExport.ts:223-257`; `apps/pos/src/admin/zip.ts:19-40`, `:59-70`, `:162-169`; `apps/pos/src/data/serverExport.ts:145-207` | 20,000 bills ≈ 60,000 lines; the archive is built as multiple full copies. A phone can freeze or hit its memory ceiling during a backup. |
| **P2** | Spreadsheet parsing is on the main thread, although [08 §7](../08-ux-guidelines.md#7-performance-budgets) requires a worker for imports | `apps/pos/src/products/sheetFile.ts:2-19`; `apps/pos/src/products/ImportPage.tsx:81-97` | 5,000-row XLSX parsing can block the counter UI; no worker exists (reports do have one). |
| **P2** | Tenant-scope validation runs three regexes on every prepared statement | `apps/api/src/db/tenantDb.ts:66-150`, `:212-220` | **≈174 ms per 10,000** long INSERTs in Node (≈10 ms for a 600-statement push). [01](../01-architecture.md#8-cloudflare-free-tier-budget) budgets the whole push at 2–5 ms CPU on the 10 ms Free plan. |
| **P3** | `pendingHeader()` queries the outbox twice on every API request | `apps/pos/src/sync/client.ts:43-49`, `:137` | Harmless for a push, but a full snapshot is ~1,000 pages → ~2,000 extra outbox queries. |
| **P3** | List virtualization is only implemented for products and Sell | `apps/pos/src/udhaar/CustomerList.tsx:295`; `SupplierList.tsx:172`; `ActivityPage.tsx:183`; [08 §7](../08-ux-guidelines.md#7-performance-budgets) | 500-customer/supplier lists and a long Activity range render every row. |
| **P3** | Expense reversal checks use a full-table filter; no Dexie index on `reverses_id` | `apps/pos/src/data/expenses.ts:282`, `:296-299`; `packages/db/src/dexie.ts:21` | Rare action, but O(all expenses) twice. |
| **P3** | Every photo upload lists the tenant's entire R2 prefix to compute usage | `apps/api/src/routes/files.ts:103-112` | One Class-A list per uploaded photo; grows with the shop's file count. |
| **P1 (process)** | No CI test exercises the documented 20,000-bill fixture; the only client perf test has **zero sales** | `e2e/tests/sell.spec.ts:247-279`; `apps/api/test/perf.test.ts:1-120`; [10 §4](../10-testing.md#4-fixtures) claims tests build the large fixture in memory, but no such test exists | The P0/P1 regressions above pass CI today. |

Severity: **P0** = a documented user-facing budget is already broken at the reference size; **P1** = serious cost that will break at year two or on low-end hardware; **P2** = real but bounded; **P3** = polish/efficiency.

---

## 1. The critical path: Sell and catalogue search

### P0-1 `soldByProduct()` is an N+1 over every bill

`apps/pos/src/data/catalog.ts:85-106` loads every sale in the last `days` range and then, for each sale, awaits:

```ts
db.sale_lines.where('sale_id').equals(sale.id).toArray()
```

At 150 bills/day and 30 days that is **4,500–5,000 separate IndexedDB queries**. The refund pass is already done correctly with one `anyOf` query; the sales pass is not.

Measured with 5,000 bills / 15,000 lines:

| Function | Run 1 | Run 2 |
|---|---|---|
| `soldByProduct(db, 30)` | 1,865 ms | 1,159 ms |
| `listProducts(db, { query: 'product 1' })` | 2,129 ms | 1,437 ms |
| `summary(db, 30-day range)` | 3,689 ms | 3,399 ms |
| `salesHistory(db, 30-day range)` | — | 74 ms (no payments seeded) |

The call graph makes this worse than a one-off screen load:

- `useSellProducts()` calls `listProducts(..., { sort: 'best' })` on mount (`apps/pos/src/sell/useSell.ts:18`).
- `useLiveQuery` tracks every table read inside `listProducts` — including `sales`, `sale_lines`, `refunds` and `refund_lines`. **Every completed sale therefore invalidates and re-runs the 1.2–2 s query while the cashier is still on Sell.**
- `ProductList` calls `listProducts` with the current search query in its dependency array (`ProductList.tsx:79-87`), so every keystroke repeats the whole thing — even when the user selected a sort other than “best”, where `sold30` is never displayed.

**Fix direction**

1. Fetch the sale lines in one pass: `sale_lines.where('sale_id').anyOf(saleIds)` in chunks (the report code already has this helper at `reportBundle.ts:274-290`), or denormalise `business_date` onto `sale_lines` so the range can be queried directly. Target: 5–10 queries instead of 5,000.
2. Do not compute `sold30` unless `sort === 'best'`; cache the result and invalidate on sale/refund writes (or update it incrementally).
3. Split the query: a small live query for products/categories/barcodes/stock, and a separate “best sellers” snapshot that does not re-subscribe to `sales` on every bill.
4. Add the missing perf test with 5,000 bills and assert `listProducts` (and Sell first paint) against the [08 §7](../08-ux-guidelines.md#7-performance-budgets) budget.

The same N+1 exists in `summary()` (`apps/pos/src/data/reports.ts:63-100`): one `sale_lines` query per sale, and for every refund line it re-queries earlier refunds. Home only asks for “today” (118 ms at 167 bills), so it is below the critical path today, but it grows linearly and is the wrong shape for any future range report.

### P0-2 Search is database-query-per-keystroke

`GlobalSearch` passes the raw input to `useLiveQuery` with no debounce and no deferred value (`apps/pos/src/shell/GlobalSearch.tsx:28-36`). `searchAll()` then:

- scans **all products** (`search.ts:29`);
- scans **all customers** (`:44`);
- calls `db.sales.orderBy('created_at').reverse().toArray()` and scans **all bills** (`:62`) — the `invoice_no` index is never used, even for an exact invoice number.

Measured at 1,000 products / 500 customers / 20,000 bills:

| Query | Time |
|---|---|
| exact invoice (`INV-19999`) | 286–470 ms |
| product name | 278–301 ms |
| customer name/phone | 239–332 ms |

Every one of those is a full result-set load followed by an early break. The Products list has the same shape: `listProducts` re-reads every product, barcode, stock level and 30 days of sales on each keystroke, then sorts with `localeCompare`.

This directly contradicts [08 §7](../08-ux-guidelines.md#7-performance-budgets), which requires “in-memory product search index (prefix + token … rebuilt on product change)” and `useDeferredValue` for result lists. Neither exists in the codebase (`grep -r useDeferredValue apps/pos/src` returns nothing).

**Fix direction**

- Build one in-memory catalogue index from a single live query (normalised names/SKU/barcode, prefix + token) and filter it with `useDeferredValue`. Product changes are rare compared with keystrokes.
- For bills, use the existing `invoice_no` index for exact/prefix searches; only fall back to text search over a bounded window (today/recent N days), not all history.
- Use the same pattern for Sales, Udhaar, Suppliers and the Pay-dialog customer search. The repository already has a `SellRow.haystack` idea (`useSell.ts:17-27`) — it just is not shared or cached.
- Add a keystroke budget test for global search and Products, not only for Sell’s grid (`e2e/tests/sell.spec.ts:247` seeds 1,000 products but **no sales**, so it never exercises `soldByProduct`).

---

## 2. Print status is a full scan hiding behind an index

`unresolvedFailedCount()` loads **every print job ever** (`apps/pos/src/data/printJobs.ts:93-94`), and `latestSaleJob()` uses a filtered collection over all jobs instead of the `sale_id` index (`apps/pos/src/data/receipt.ts:230`) even though the V2 schema has that index (`packages/db/src/dexie.ts:54-57`).

Measured with 20,000 jobs: **≈100 ms** for `unresolvedFailedCount`.

Call sites:

- `PrinterDot` in the shell (`TopBarParts.tsx:276-282`) — a live query, so the scan runs whenever `print_jobs` changes. A printed sale changes it at least twice (`printing`, then `done`), so every receipt can trigger two or three full scans while the cashier is in the app.
- Home attention (`home.ts:100`).
- Sale complete (`receipt.ts:226-239`) — once per sale.

**Fix:** query `where('status').equals('failed')` (status is indexed) and only resolve the “superseded by a later done job” question for those few jobs, using `sale_id`/`refund_id` indexes; use `where('sale_id').equals(...)` in `latestSaleJob`. If print history is meant to be retained, prune `done` jobs older than a documented window (30/90 days) in the same place that prunes other local history. Add a test with 20,000 jobs.

---

## 3. Write path: all-table transactions and growing ledger scans

`writeAction` opens `db.transaction('rw', db.tables, run)` (`apps/pos/src/data/write.ts:293`) for every action, including a single cart edit or product rename. `db.tables` covers all ~40 stores. In IndexedDB a read-write transaction locks every store in its scope, so:

- every sale edit is serialised with sync pull/push transactions;
- a read (`useLiveQuery`) on any table waits behind the write;
- unrelated writes (for example a cart save) cannot proceed concurrently.

The action itself may touch only a handful of tables, but the transaction is wider than necessary. This is not visible on a small shop; it is exactly the sort of overhead that turns a 30 ms sale commit into 150 ms when a pull page is applying.

Worse, a credit sale inserts a ledger row (`sale.ts:498`), and `applyLedgerEntry` then re-reads **all ledger entries of that party** (`caches.ts:64-73`) and calls `oldestUnpaidAt`, which copies and sorts them (`packages/core/src/money/ledger.ts:30-37`). A customer with five years of credit history pays that cost on every new udhaar sale, inside the all-table transaction.

`mergeRows` has the same pattern on pull: for every **new** ledger row it calls `applyLedgerEntry` (`apps/pos/src/sync/merge.ts:114`), so a 500-row pull page with many ledger entries does up to 500 party scans inside one transaction that also locks `outbox` — the store a sale write needs.

**Fix direction**

- Give each repository/action an explicit table list. Keep the outbox/caches in the scope, but do not lock the entire database for a product rename or a cart save.
- Make the ledger balance incremental: the cache row already has `balance`, `last_activity_at` and `oldest_unpaid_at`; an inserted entry can update it from the previous cache row plus the new amount without re-reading the history. Recompute the full history only in `rebuildCaches`/`checkCaches`.
- For pulls, group ledger rows by party and apply the cache update once per party per page.
- Add a sale-commit benchmark with a customer that already has 5,000 ledger entries; assert the [08 §7](../08-ux-guidelines.md#7-performance-budgets) 150 ms budget.

---

## 4. D1: the day-close push scans the whole shop

The three close lookups added to `loadLookups` filter on `created_at` and `device_id`:

```sql
SELECT ... FROM payments
WHERE tenant_id = ?1 AND created_at > ?2 AND created_at <= ?3
  AND device_id IN (...)
```

The same shape is used for `cash_moves` and `expenses` (`apps/api/src/sync/applyOps.ts:3958-3980`). The only D1 indexes are:

- `payments_date (tenant_id, business_date, device_id)`;
- `expenses_date (tenant_id, business_date)`;
- `cash_moves` — primary key only.

`EXPLAIN QUERY PLAN` on the real migrations confirms they use only the tenant prefix:

```
-- close payments
SEARCH payments USING INDEX sqlite_autoindex_payments_1 (tenant_id=?)
-- close cash moves
SEARCH cash_moves USING INDEX sqlite_autoindex_cash_moves_1 (tenant_id=?)
-- close expenses
SEARCH expenses USING INDEX expenses_date (tenant_id=?)
```

That means SQLite scans **every payment/expense/cash move the shop has ever written** to return one day's rows. At 150 bills/day a year-old shop has ≈55,000 payments; a two-year shop ≈110,000. The push still returns the right rows, but it burns D1 rows-read and adds latency to the daily close — exactly the operation that already has a quota barrier ([13 §6](../13-multi-tenancy.md#6-free-tier-budget-per-shop)).

**Fix**

Add an additive migration (`0011_perf_close_indexes.sql`) with:

```sql
CREATE INDEX payments_device_created ON payments (tenant_id, device_id, created_at);
CREATE INDEX expenses_device_created ON expenses (tenant_id, device_id, created_at);
CREATE INDEX cash_moves_device_created ON cash_moves (tenant_id, device_id, created_at);
```

or rewrite the close queries to filter on `business_date` (the date range is derivable from `period_start`/`period_end` and the shop timezone), which lets `payments_date`/`expenses_date` do the work; add a `cash_moves` date index in any case. Then extend `apps/api/test/perf.test.ts` to include the three close queries in `HOT_QUERIES` and assert the composite index names — the current test only covers the pull/push/sale/refund/stock queries.

The rest of the D1 query set is good: `change_log` pull uses `(tenant_id, seq)`, snapshot pagination uses the composite primary key, `applied_ops` uses its primary key, and the lookup `IN` chunks stay under the 100-parameter limit. No other missing index was found in the hot read paths.

---

## 5. Reports, exports and imports

### Reports are off the main thread, but not bounded

`reportBundle` correctly runs in a worker (`apps/pos/src/reports/reportWorker.ts`), which protects the counter’s UI. The cost inside the worker still grows with history:

- `byAnyOf`/`byIds` deliberately fall back to a **full table scan** when asked for more than 200 ids (`reportBundle.ts:260-290`). A 30-day range easily has >200 bills, so the sale-lines, payments, refund-lines and stock-movement tables are read in full.
- The stock tab loads **all stock movements up to today** to find the last sale date per product (`reportBundle.ts:737-742`), regardless of the selected report range.
- A page with 10,000 products and 100,000 bills will materialise hundreds of thousands of rows in the worker; the 300 MB memory budget in [08 §7](../08-ux-guidelines.md#7-performance-budgets) is not enforced.

**Fix:** keep the worker, but (a) use chunked `anyOf` with a larger, measured threshold instead of a full scan, (b) maintain a local `product_last_sale` cache (updated on sale/void writes) or restrict slow movers to the last 12 months, and (c) add a benchmark with the large fixture that records report duration and peak memory per tab.

### Whole-shop exports duplicate all data in memory

`buildShopExport` (`apps/pos/src/data/shopExport.ts:198-258`) loads every table with `toArray()`, builds both JSON and CSV strings, and then `zipStore` concatenates them into one `Uint8Array`. `crc32` is a pure-JS loop over every byte (`admin/zip.ts:19-40`), and there is no worker. `buildServerExport` (`serverExport.ts:145-207`) has the same “collect every row then encode” shape, even though it fetches pages.

At the reference size this is tens of megabytes; at year three it is hundreds. On a phone, a backup can freeze the app for seconds and can exceed the tab’s memory. This matters more than a normal report because the export is the recovery path.

**Fix:** stream table files through the ZIP writer (or use `CompressionStream` in a worker) and avoid keeping the JSON, CSV and ZIP copies alive at once; write the ZIP to a `Blob` per table and concatenate lazily; show progress per table. If streaming is too large a change for v1, cap the in-memory export and document “use the server export on a desktop for large shops”.

### Import parsing is on the main thread

`readSheetFile` dynamically imports `read-excel-file` and PapaParse, then parses the entire file synchronously in the click handler (`apps/pos/src/products/sheetFile.ts:2-19`). [08 §7](../08-ux-guidelines.md#7-performance-budgets) explicitly lists “Web Worker for reports and imports”; reports have one, imports do not.

**Fix:** move `readSheetFile` + `previewImport` into a worker (Dexie can be opened from a worker, as the report worker already proves) or at least parse/chunk with yields; keep `MAX_IMPORT_ROWS = 5000` and assert the 10 s import budget in e2e with a 5,000-row file.

---

## 6. Startup and bundle

`pnpm size` passes but with almost no room:

```
initial JS: 288.0 KB gz across 93 file(s) + the largest language catalog (15.2 KB); 203 JS file(s) total
bundle size: pass (budget 290 KB)
```

The build also emits **93 initial JS files (91 `modulepreload` links)** in `index.html`, **203 JS chunks** and **206 precache entries (2,324 KiB)**. The initial graph is large because `autoCodeSplitting` is off (`apps/pos/vite.config.ts:40`) and these routes are statically imported rather than `lazyRouteComponent`:

- `/sell` — `routes/sell.tsx` imports `SellPage` directly;
- `/products` — `routes/products/index.tsx` imports `ProductWorkspace`, which pulls `ProductList` + `ProductDetail`;
- `/products/new` and `/products/$id/edit` — import `ProductForm` directly;
- `/stock/count` — imports `StockCount` directly.

Only the operator console, Sales/day-close/expenses/reports, labels and most settings pages are split. The result is that a cashier on first visit downloads/parses product forms and stock-count code before the PIN screen, and a new feature has only 2 KB of headroom before the gate fails.

**Fix:** make every route except Home and Sell a lazy route (or enable `autoCodeSplitting`), keep `ProductWorkspace` and `ProductForm` in their own chunks, and measure the initial graph against a target well below the hard cap (for example 200 KB) so the budget is a guard rail, not a constant fire. Consider merging the many tiny chunks (there are dozens under 2 KB) if the request count proves to matter on the reference phone; the current 93 preloads are a lot of HTTP overhead for a cold install.

The service worker precache (206 entries, 2.3 MB) is acceptable as a one-time install, but it should be measured on the Redmi-class device alongside the 1.5 s cold-start budget.

---

## 7. Rendering and list behaviour

### Intl formatters are built per cell

`businessDate` creates a new `Intl.DateTimeFormat` on every call (`packages/core/src/dates.ts:2-13`); `formatTimestamp` does the same (`apps/pos/src/lib/date.ts:48-51`); `formatMoney` creates a new `Intl.NumberFormat` for every amount (`packages/core/src/moneyFormat.ts:54-57`). `SalesList` calls `businessDate` per row (`SalesList.tsx:553`), and every money cell calls `formatMoney`.

Microbenchmark on this machine:

| Operation | Per 10,000 |
|---|---|
| `new Intl.DateTimeFormat(...).formatToParts` | 1,064 ms |
| cached `DateTimeFormat.formatToParts` | 78 ms |
| `new Intl.NumberFormat(...).format` | 613 ms |
| cached `NumberFormat.format` | 19 ms |

A 50-row Sales render creates roughly 100 formatters; on a low-end phone that is tens of milliseconds of avoidable work in every list render. Use module-level `Map<locale|timezone|style, formatter>` caches (or a single `Intl.Collator` for sorting) and reset them only when the language/timezone changes.

`listProducts` also sorts with `String.localeCompare` on every comparison (`catalog.ts:190-199`); a 5,000-product sort was 22 ms for the collation alone on this machine (vs 2 ms for a normalized key). For a 1,000-product shop this is minor, but it compounds with the P0 query.

### Virtualisation is only half done

`ProductList` and `ProductGrid` are virtualised, but `CustomerList` renders every customer (`udhaar/CustomerList.tsx:295`), `SupplierList` every supplier (`suppliers/SupplierList.tsx:172`) and `ActivityPage` every audit row in the range (`settings/ActivityPage.tsx:183`). [08 §7](../08-ux-guidelines.md#7-performance-budgets) requires virtualisation above 100 rows. At 500 customers this is tolerable; at a shop with 5,000 customers or a year of activity it is not.

### The two most expensive “other” searches

- `refreshPromises` (`udhaar.ts:599-641`) loops every open promise and queries that customer's full ledger. It runs on the Udhaar list mount (`CustomerList.tsx:60-73`), so opening Udhaar can do hundreds of ledger queries before the list paints. Group by customer and use the `party_balances` cache plus the ledger index already available.
- `supplierList` (`suppliers.ts:83-106`) loads **all purchases** on every keystroke to compute last delivery dates, and `findCustomers` (`customers.ts:46-78`) loads all customers and all balances on every Pay-dialog keystroke. Both are fine at 500 rows and both become noticeable at a few thousand. Cache `lastDeliveryDate` on the supplier row (or a small local table), and build a customer index once per session.

---

## 8. API CPU, R2 and smaller items

### Tenant-scope validation can eat the Free CPU budget

`tenantDb.prepare` calls `assertTenantScoped(sql)` for every statement (`apps/api/src/db/tenantDb.ts:212-220`), which runs `TABLE_REF`/`TENANT_PREDICATE` regex scans plus alias checks over the full SQL text. The SQL strings are effectively a small set of shapes (one INSERT template per table, one change-log insert, one applied-op insert), but they are re-scanned on every statement.

Measured: **174 ms / 10,000** typical 22-column INSERTs (≈0.017 ms each). A 200-op push emits roughly 600 statements, so the validation alone is **≈10 ms** — the whole Free-plan CPU budget per request ([01](../01-architecture.md#8-cloudflare-free-tier-budget) quotes 2–5 ms for a 200-op push). This is a plausible source of `Worker exceeded CPU time limit` errors under load, even though the D1 work is off-CPU.

**Fix:** cache the result by SQL string in a module-level `Map<string, true>` (bounded, or keyed by a hash); the number of distinct SQL shapes is small. Keep a test that every builder still throws when a tenant predicate is missing.

### Smaller items

- `pendingHeader()` runs two outbox queries on **every** `tillRequest` (`sync/client.ts:43-49`, `:137`). A full snapshot is ~1,000 pages; cache the count and oldest value in memory, update on outbox writes, and send the header on pushes (and occasionally on pulls) rather than every page.
- `putFile` lists the entire `t/<tenant>/` R2 prefix on every upload to compute the 1 GB usage (`routes/files.ts:103-112`). Maintain a counter in D1/usage, or compute the size only when the object would cross the cap.
- `reverseExpense` scans all expenses twice (`expenses.ts:282`, `:296-299`); add `reverses_id` to the Dexie `expenses` index (and `created_at` to the same index if the table grows).
- `businessDate` is also called in a loop in `ActivityPage.tsx:192`; the formatter cache above fixes that too.
- The operator tenants list and the public shop-request list sort in SQLite without a covering index (`tenantAdmin.ts:39-46`, `shopRequests.ts:255-260`). Both tables are small today; revisit when the platform has hundreds of shops.

---

## 9. What is working

- **D1 write path:** push batches parents before children, checks idempotency in chunks of 99, keeps the 100-parameter/40-call budget, and accumulates `tenant_usage` in the same batch. The 150-bill T-062 test and the 20,000-bill size measurement both pass and match the docs (1,961 bytes/bill, ≈155 MB/shop-year).
- **Hot D1 indexes:** the pull, snapshot, sale/refund/stock and ledger queries all use tenant-leading indexes; `apps/api/test/perf.test.ts` is a good foundation and should be extended with the close queries.
- **Reports:** a real module worker, not a fake `setTimeout`, with a main-thread fallback and progress.
- **Product/Sell lists:** virtualised rows/tiles, a scan path that uses the barcode index, and an 80 ms scan check in the e2e suite.
- **PWA:** admin routes are excluded from the precache, API is never runtime-cached, and the service worker scope stays under `/bikri/`.
- **No obvious timer/listener leaks:** intervals and object URLs have cleanup; the DB closes on tenant switch; file cache is bounded at 2,000 entries.

---

## 10. Recommended order and acceptance criteria

1. **Sell/catalogue reads (P0).** Replace the per-sale query with one chunked pass or an incremental `sold30` cache; stop re-running the “best” query after every sale; add the large-fixture test.
   - Sell first usable < **400 ms** with 1,000 products + 20,000 bills (desktop and 4× CPU throttle).
   - Product search keystroke → painted < **50 ms**.
   - `soldByProduct` on 5,000 bills performs **≤ 10** IndexedDB queries.
2. **Global search + all list search (P0/P2).** In-memory normalized indexes, `useDeferredValue`, invoice/SKU/barcode index lookups first, bounded date windows for free text.
   - Global search keystroke < **50 ms** at 20,000 bills.
   - No full-table `toArray()` on any search path.
3. **Print jobs (P1).** `failed`-status query + `sale_id` index in `latestSaleJob`; prune old done jobs; 20,000-job test.
4. **Day-close D1 queries (P1).** Add the three composite indexes (or use `business_date`), add them to `HOT_QUERIES`, and assert rows read for one close stays near one day's data.
5. **Write path (P1).** Narrow `writeAction` scopes; make `applyLedgerEntry` incremental; group ledger rows per party during pull.
   - Sale commit p95 < **150 ms** with 5,000 ledger entries for the customer.
6. **Reports/exports (P1/P2).** Remove the >200-id full scans; bound slow movers; stream the ZIP or move it to a worker; move sheet parsing into a worker.
7. **Bundle (P1).** Lazy-load Products/Stock/forms; aim for ≥ 30 % initial headroom; measure cold start on the reference phone.
8. **CI (P1).** Add the documented large-fixture Playwright perf test (Sell ready, product/global search keystroke, sale save, report load) and extend the Worker perf test with close queries and `EXPLAIN` assertions. Update [10 §4](../10-testing.md#4-fixtures) if the fixture is not actually used by tests.

**Do not** optimise by removing correctness protections (tenant predicates, append-only checks, money helpers) to buy speed. Every fix above is structural: fewer round trips, narrower scopes, cached immutable data.

---

## Appendix A — measurement details

The temporary benchmarks seeded a fresh tenant DB with bulk inserts and called the production functions directly:

1. 1,000 products, 5,000 sales over 30 days, 15,000 sale lines, 1,000 stock levels; then `soldByProduct`, `listProducts({ query })`, `summary(30d)`, `summary(today)`, `salesHistory(30d)`.
2. 1,000 products, 500 customers, 20,000 sales over 120 days; then `searchAll('INV-19999')`, `searchAll('product 999')`, `searchAll('customer 499')`; then 20,000 `print_jobs` and `unresolvedFailedCount`.

The tests were run with `vitest run --coverage=false` and removed afterwards. They used `fake-indexeddb` in Node 26 on the development machine; **absolute device numbers will differ**, but the N+1 shape and the full scans are independent of that.

Bundle and D1 measurements came from the real build and the real migrations:

```text
pnpm --filter @bikri/pos build   # PWA build
pnpm size                        # 288.0 KB gz initial / 290 KB; 93 initial JS files; 203 total; 206 precache entries
node tools/perf/measure-d1.mjs   # 20,000 bills, 2 tenants: 1,961 bytes/bill, 154,788,352 bytes/shop-year
```

D1 plans were checked on an in-memory database built from every `packages/db/migrations/*.sql` file, including `0003_perf_indexes.sql`. The close query plans are quoted in §4.

## Appendix B — things deliberately not counted as findings

- The 30-day `change_log` / 90-day `applied_ops` retention and the per-shop budget are a deliberate product decision; the measured 155 MB/shop-year is within the documented storage plan. This review only flags that the **close queries** read far more rows than the model assumes.
- Keeping a full local copy of the shop for offline use is a requirement, not a bug. The issue is that the read paths materialise it repeatedly; the fix is indexing/caching, not removing data.
- The PWA precache of 2.3 MB is a one-time install cost and is excluded from the JS budget; it is worth measuring on the reference phone but not a defect by itself.
