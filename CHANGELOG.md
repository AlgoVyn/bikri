# Changelog

All notable changes to Bikri. The version is the deployed `APP_VERSION`; migrations are listed separately.

## [Unreleased]

### Final review residuals — 22 Nov 2026
- Dexie V14 drops the unused standalone `sale_lines.bundle_id` index and adds `outbox.tx_id`; `discardFailed` now reads one rejected transaction instead of the whole queue.
- Sales, Expenses and Reports wait for the shop timezone before seeding saved date filters; the shared timezone hook reports readiness without changing hook order.
- Snapshot pages charge D1's real `rows_read`; a test-only `x-bikri-d1-calls` / `x-bikri-apply-ms` header gives the 200-op gate a call and internal-apply guard alongside the wall-clock proxy.
- Product unit changes round fractional opening/minimum, refuse an integer unit while tracked stock is fractional, and never clamp a missing bundle component to `pc`; ReadOnlyError shows the read-only toast in the remaining day-close/expense/supplier/customer dialogs; label/print/download promises are caught.
- `loadAreaCatalog` is a static import (it was already in the initial graph) and the delivery CSV loads with the other delivery exports; the bundle test drops its duplicate price assertion.

### Print agent 0.1.8 — 22 Nov 2026
- Windows GDI driver mode paginates receipts taller than `VERTRES`; Linux/macOS archives include the uninstallers. Wizard links, Inno version and the build fallback move to 0.1.8.

### Review residual fixes — 22 Nov 2026
- Home recomputes recent bills when the device branch resolves; Restore discards a ZIP that finishes inflating after a newer pick; device admin actions share a synchronous busy guard; Sync Now/Retry have rejection handlers.
- Printer wizard gates the test-print drawer kick by `drawer.open`, read-only/support and the saved setting; palette privacy has success/error toasts; expense/cash/category/backdate/price/suggested/import submits use the synchronous submit guard, and Expense Save requires `expense.create`; settings persistence promises are caught.
- Label preview shows the shop name, localized name, price and human-readable barcode; Urdu activity uses the Settings term; the ledger credit total is safe-integer checked; a rejected tracked-cost edit no longer leaves an orphan photo blob.
- Raster text is sized from the laid-out column count, Windows GDI splits tall receipts into VERTRES page bands, and the Linux/macOS archives now ship the uninstallers. Docs rate-limit bindings match `wrangler.jsonc`.

### Tests, CI, tooling and docs — 22 Nov 2026 review recheck
- Journey 20 now proves the `410 SNAPSHOT_REQUIRED` and snapshot hydration with a second till, asserts the raised floor/cursor, and restores from a point captured before an offline sale; the local-D1 selector ignores `metadata.sqlite`.
- Journey 23 covers two pre-read-only offline sales, a blocked `/sell` deep link, and readable Sales/Reports/Activity/Export; bundle tests cover the amber short-stock warning, stock return after refunds, recipe edit + historical reprint, and real `systemPrint`; the tenant test calls `getDb()`.
- The isolation suite adds `/admin/tenants/:id/owners`, import `tenant_id` rejection, enrolment-branch/devices/files HTTP scoping, 404 body equality, `enrolled_by` omission, and schema/static checks for `tenant_usage`, `change_log_watermarks` and `platform/*`.
- The Worker suite adds 201-op/1 MB push boundaries, the 200-op wall-clock guard, backup download traversal rejection, and a 90% line coverage gate; `newId()` initialises its PRNG lazily so coverage instrumentation cannot crash it.
- Docs and tooling: CSP/version/migration-order checks, SQL arity checks, package README links, string-masked migration DDL, comment-stripped table generation, seeded `branch_device_codes`, no overwritten `cost_changed_at`, backup upload failure on a missing file, and CI timeout/race/concurrency/printf hardening.

### Printing and print agent 0.1.7 — 22 Nov 2026 review recheck
- The Windows portable installer no longer wipes `HKCU\...\Run` and waits for the old process before copying; RAW fallback recognises `ERROR_INVALID_DATATYPE (1804)`.
- Web Serial abort is bounded; jobs never overwrite terminal state and only terminal jobs are evicted; `crash.log` is capped and config saves fsync before rename.
- 80 mm Urdu sale/refund column headers no longer re-wrap; ASCII Urdu-raster lines use the monospace face; credit statements stay ASCII; wrapped lines keep their leading indent and an overflowed item no longer repeats its price detail; CUPS uses the PNG width for ppi/media; Windows GDI scales asymmetric DPI and resets the brush origin.
- Label printing has a font timeout and awaits the print dialog; the preview filters by barcode and shows name/price; refund receipts print the configured QR; supplier-return quantities use the shared formatter; Linux/macOS uninstallers and ARM macOS download are present.

### POS UI and operator console — 22 Nov 2026 review recheck
- Fractional bundle quantities clamp correctly, `ProductForm` computes on-hand after the draft loads, and Reports shows the product unit for minimum stock.
- Restore validates every row before the purge, ignores stale file picks, and resets the Restore tab after maintenance ends.
- Whole-bill bundle refunds keep the restock checkbox; Home recomputes all attention items and scopes recent bills; global search gates customers by `payment.receive`.
- Price Check hides Add product in read-only mode, guards late lookups and toasts failed cart adds; Home gates reports/backup/sell links and attention destinations.
- Inline price commits once and restores on empty blur; owner sign-in ignores closed responses; sync file removal/acknowledge obey owner/read-only; wizard test prints do not open the drawer and USB/serial controls follow browser support.
- Restore/Sales deep links, expense date validation, item counts, cart arrow order, command palette dialogs/privacy, supplier-return zero lines, PromiseDialog timezone guards, category RTL input, label printing in read-only, report keys/deltas/peak, clipboard/plural/category filters and Price Check keys are fixed.
### POS data and sync — 22 Nov 2026 review recheck
- A delivery with `updatePrice` now verifies `catalog.edit` in the repository; the Worker accepts the costed delivery and the price change.
- Outbox coalescing is limited to one transaction and actor, so a delivery/recipe companion can no longer be split from its product edit.
- Earlier-day voids and reissues now require an owner approval on the till, matching the Worker; the reissue override is bound to the owner.
- `discardFailed` keeps a newer pulled row instead of restoring a stale shadow; pull merge clears the consumed shadow.
- Restore recovery drops no-op master ops, advances `base_rev`, keeps a bundle product with its recipe, strips a costed product's old `last_cost`, and gives each unit its own transaction.
- Sync engine coalesces push+pull into a full run; read-only includes support devices; file uploads use a tenant-scoped cross-tab lock; stock count awaits the draft chain; import preview rejects a SKU owned by a soft-deleted product; day-close boundaries and support/upload counts are aligned.

### Worker API and sync — 22 Nov 2026 review recheck
- Push planning advances `look.current` between transactions and bisects a lost `guardAssert`, so editing then deleting the same row in one push no longer wedges the till; D1 singleton failures stop the round and re-plan from committed state.
- Rejected transactions no longer leak their customer/supplier/sale/refund lookups into later transactions; payments and ledger rows still require an applied or same-transaction party, while FK-backed sales/purchases may reference a party created later in the push.
- A soft delete through `customers`/`suppliers` upsert now enforces the zero-balance rule; duplicate ledger inserts guard their side effects; a reissue validates a changed bundle price/recipe instead of rejecting every edit or bypassing checks.
- Support expiry re-checks the deadline in SQL and only audits when devices were revoked; device edits/revokes use optimistic guards; owner PIN reset is one atomic batch; malformed Access JWTs return 401 instead of 500; shop requests mask emails and cannot overwrite `failed`.
- `last_cost` guards use the effective `track_stock` write list; `void_return` deduplicates same-transaction sale lines; malformed day closes no longer poison the lookup window; purchase stock repair uses BigInt; partial staff PIN writes are rejected; read-only/support pull reads flush in coarse batches.

### Core and DB — 22 Nov 2026 review recheck
- `formatQtyFromMilli()` formats fractional values for integer units instead of throwing, so a `kg` sale no longer crashes Sale Complete, Sales History, Reports or Product Edit; `parseQtyToMilli()` still rejects fractional `pc` input.
- Migration `0030` now splits its 24-pair `json_object` into a 16-pair `json_object` plus `json_insert` (D1's 32-argument limit), and migration `0031` applies the corrected cost repair and bundle triggers to shops that already recorded `0030`. The `json_insert` paths include their `$.` prefix; the first deploy attempt failed with `bad JSON path` and was rolled back before the Worker deploy.
- The `0031` repair publishes the `0024` `avg_cost` rows that `0030`'s `avg_cost = 0` predicate missed; the bundle movement trigger now checks `simple -> bundle` and existing movements, and `bundle_items` gets parent-kind, resurrection and `deleted_at` guards.
- `roundCashRefund(..., 'none', cap)` returns the remaining paid amount instead of a rupee-floored amount; quantity/percent/money parsers accept `.5`, `٪` and non-breaking spaces; allocation and money helpers validate safe integers and non-negative values.
- `roman-ur` plural lookups use English one/other rules even on an Arabic/Russian host locale; i18n checking rejects malformed braces in every locale; Urdu/Roman Urdu till, settings and bundle-missing strings are corrected.
- `check-migrations-safe` rejects SQL function calls above 32 arguments; the Dexie schema docs now include V13, the V11 `created_at` indexes and the `initial_sync_pending`/`pull_errors` keys.

### Review leftovers — 22 Nov 2026
- Snapshot start no longer carries the dead per-table `COUNT(*)` branch; all callers already used row-based progress.
- The read-only cutoff docs now state that a push records `read_only_seen_at` even when it ends in 403, so a later `/me` or pull cannot widen the grace window.
- Test honesty: the enrolment eviction test proves the kept bucket still blocks and the evicted one restarts, the expense-override test targets the expense it approves, the row-JSON test counts SQL arguments and executes the sales expression, and the public-request rate limiter is exercised.

### Print agent 0.1.6 — 22 Nov 2026 review
- Release `print-agent-v0.1.6` with the Windows GUI log fan-out, `GetDefaultPrinterW` length query, CUPS natural scaling/ppi/media, GDI DPI scaling and Web Serial cleanup fixes, plus the job-state, installer and raster hardening from the review.
- The wizard download links, Inno installer version and build fallback move to 0.1.6. The HTTP protocol stays 1, so an older agent keeps working until the shop updates.

### POS sync and data remediation — 22 Nov 2026 review
- A pulled `sale_voids` row that loses its offline race with another till now removes the whole losing local void transaction (void, reversal payments, ledger, movements, audits and their outbox ops) before the server's void is written, on both incremental pull and snapshot, and the caches are rebuilt.
- Restore recovery groups a void & reissue under its replacement sale, so a 200-op chunk boundary can no longer split the reissue into two rejected transactions.
- `closeDay` clamps `period_end`/`created_at`/`business_date` after a backward clock correction instead of writing an unclosable period.
- Enrolment persists `initial_sync_pending` until the first snapshot completes; the app gate stays on the enrol screen and `SyncEngine.start` refuses to run while it is set, so a reload resumes the download instead of starting a competing engine.
- `receivePayment` reads the acting staff row and only refreshes promises when it may `party.edit`, so a `payment.receive`-only role no longer has its payment rejected.
- Push settlement never lowers a newer revision applied from a pull shadow, and transport/unanswered resets only release the claim token they own.
- A coalesced master edit now notifies `onLocalWrite` even though it queues no new op, so search and Price Check refresh immediately and the push still starts.
- The sync engine coalesces follow-ups into one pending run, preserves the read-only `learned_at` age, records the fallback pull's last-sync/clock skew and skips file uploads while the shop is known read-only.
- Backdated bundle component lines no longer require a `catalog.edit` approval, and an unnecessary approval for a full-price bundle is not audited.
- Stock count cancels its debounced draft before finishing and stamps every draft save, so a second tab's discard is noticed instead of resurrected; the applied set stays with the committed chunks.
- Search ignores soft-deleted barcodes; the till's staff role falls back to cashier (not owner) before the live query resolves; export session writes tolerate a full/blocked `sessionStorage`; a rejected `caches.open` is retried instead of cached forever.
- Supplier returns verify the remaining delivered quantity before writing, slow movers read every void (not just 30 days), `refund_lines` ops carry only server columns, product photos are cached after the read-only guard, and an unchanged shop settings save writes no audit row.

### Review remediation — 22 Nov 2026
- `bikri-export` strips till-only columns (`refund_lines.business_date`) and the operator restore also strips them defensively, so a till backup restores after the live purge.
- Dexie V13 repairs refund lines that were pulled or replayed without `business_date`; the pull derives the date from refunds on the same page and restore replay reattaches it from the parent refund.
- A batch with several ledger rows for one party recomputes that party's balance once instead of counting later siblings twice.
- Migration `0030` republishes the `0024` `avg_cost` repair through `change_log`, advances `cost_changed_at` only for costed receipts, rejects negative movement costs, and adds database backstops for bundle recipes, bundle stock movements, bundle discounts and watermarks.
- The restore ZIP grows its inflate buffer with the real output, caps the total archive, skips CSV entries, rejects duplicate manifest tables and keeps one active restore per tenant.

### P3 polish — 21 Nov 2026 review
- `tenantDb` hoists its alias-keyword set and FIFO-evicts one verified statement at a time instead of clearing all 1,000; the enrolment limiter evicts by Map insertion order (refreshed on each failure) instead of sorting 10,000 buckets; imported HMAC keys are cached per secret.
- Server exports page by their signed `export_id` without re-reading the owner row and session on every 500-row page. Owner sign-in, device edit and device revoke now write their update, change-log row and audit row in one `onlyIfChanged` batch instead of two.
- Operator formatters cache `Intl.NumberFormat`/`Intl.DateTimeFormat` per language; supplier returns reuse `businessDate()`; the lock screen ticks once per second only while a lockout counts down (30 s otherwise) and auto-lock reschedules at most once per second.
- Product detail reads the shop row once for time zone, cost method and money format; the day-close footer uses an opaque surface with a shadow instead of `backdrop-blur`.
- The report worker keeps one Dexie connection per tenant, batching uses one `TextEncoder`, price check reuses the normalized search cache, and supplier returns read only the last 180 days through `[supplier_id+created_at]` with `anyOf` chunking.
- Migration `0024` carries a historical note that its one-time `NOT EXISTS` scan ran after the index was dropped; new backfills must keep an index or page by id.

### Build, core, printer and agent polish — 21 Nov 2026 review
- Web workers are emitted as ES modules, so the sheet parser's dynamic imports (Papaparse, read-excel-file) load only when an import runs instead of being bundled into one classic worker.
- The online-only public shop-request catalogs move to `assets/public/` and leave the PWA precache; the operator console stays under `assets/admin/`.
- `can()` fast-paths empty permission overrides and caches the last parsed JSON; `businessDate` uses the `en-CA` formatter directly; receipt dates fill their parts in one pass.
- `allocate(0, …)` skips the BigInt split, `mulDivRound` fast-paths exact safe products, `opRow` uses precomputed column sets, printer clipping segments Urdu strings once, `ByteBuf` grows a single buffer and Code 128 reads pattern digits without allocating.
- USB jobs share one deadline across open/claim/chunks; serial writes scale the timeout with the payload and baud rate; system print caches the extracted `@font-face` CSS; `isPinTaken` hashes candidates in parallel; top-bar search caches normalized product/customer/invoice keys.
- The print agent rotates `agent.log` while running (5 MB, one previous file), drops the base64 payload reference after decoding and sweeps expired rate-limit buckets.

### UI cost and responsiveness — 21 Nov 2026 review
- Cart and bundle quantity inputs now commit after a 200 ms pause or on blur/Enter instead of writing Dexie on every digit, so a typed quantity is one cart write.
- Closed dialogs stop their live queries (held bills, backdate staff, expense categories/zone, approvals, receive-payment zone, delivery detail) until opened.
- `ProductList`, `ProductForm`, `PricesPage` and `StockCount` read only category rows (`listCategoryOptions`), not all 5,000 products; `ProductForm` also skips the stock-level/bundle catalogue read for simple products, tracks dirty state without `JSON.stringify`, and revokes the photo Object URL.
- `MoneyText` only subscribes to translation in privacy mode; `ScrollStrip` reads direction once per language instead of every scroll frame; `ProductDetail` and the operator Tenants list render one responsive layout instead of two.
- Statement rows reuse their formatted date and customer/supplier searches use precomputed name/phone keys and one collator.
- PDF/PNG modules for statements, deliveries and reports load on click instead of in the first bundle.

### Client write path — 21 Nov 2026 review
- Dexie V12 drops unused indexes (including three prefix indexes covered by a compound one) and adds `file_queue.[status+created_at]` and `sale_voids.business_date`; retention now reads primary keys instead of every failed blob/done job.
- Push settlement bulk-loads the claimed rows, deletes applied ops in one `bulkDelete`, writes rejected/pending rows in one `bulkPut`, and skips `pull_shadow` work for ledger inserts. `discardFailed` reads the outbox once, narrows its lock to the action's tables and bulk-deletes ledger rows.
- Refund, purchase and stock-count actions use `insertMany`/bulk reads: refund lines, movements and audits, purchase lines/movements/price audits, and count movements; `finishCount` reads products and stock levels for the whole chunk instead of 90 history scans.
- File cache reopens `CacheStorage` once per storage object, prunes failed uploads by primary key, and `checkCaches` samples movements and levels in one read transaction so a concurrent sale cannot trigger a false rebuild.

### D1 write/read capacity — 21 Nov 2026 review
- Migration `0029` drops four unused indexes (`products_kind`, `purchases_supplier`, `supplier_returns_supplier`, `audit_log_time`), narrows `ledger_source` to refund rows and `payments_sale` to void rows, makes `stock_movements_ref` and `ledger_party` covering, and replaces the per-row `change_log_prune` index with a per-tenant daily `change_log_watermarks` table.
- The nightly prune records each tenant's daily `MAX(seq)` and reads its cutoff watermark; the first run after deploy derives the mark once. This removes the 9 D1 writes/bill the old prune index charged and the per-tenant `MAX(seq)` scans.
- A push updates `devices.last_invoice_seq` once with `MAX(...)` instead of once per sale, sale-status recomputation no longer joins `refunds`, and only void reversals are looked up by `sale_id` (normal sale/refund payments use their own ids).
- Operator export pages no longer run 29 `COUNT(*)` scans (`counts=false`), matching the till and owner exports.

### Remaining P1 performance batch — 21 Nov 2026 review
- Sales history reads failed print jobs from the status index and refunds from the range start; the chase list uses the party-balance cache's new `last_payment_at` instead of scanning payments. Bundle detail reads only its 14-day `[bundle_id+business_date]` lines and its own component stock; restore recovery bounds parent rows by `created_at` and reads child lines only for recovered parents.
- Hidden master lists and the Settings nav no longer mount below 1280 px; Chase, Reports, Customers, Suppliers and Activity render bounded pages instead of unbounded/infinite-scroll DOM.
- The shell computes staff, read-only and the shop time zone once, runs the print queue in a null leaf, rebinds its global keydown once, and reads `shopTimeZone` from its own module (initial JS 284.6 → 279.4 KB gz).
- The pre-paint theme is inline under a CSP `sha256` hash with a language-aware font preload; Noto Naskh switched to the variable face (precache 941.0 → 874.4 KB gz). Raster text thresholds straight from the source, canvas line bitmaps are reused, and drawer-only/ASCII print jobs skip fonts and the logo. The agent poll starts at 100 ms and driver mode uses async `canvasBlob`.
- `oldestUnpaidAt` is O(N), the bundle gate reads the exact locale preload map, the D1 measurement has an upper bound, and a 4× CPU keystroke guard runs in Playwright.

### Sale and catalogue hot path — 21 Nov 2026 review
- `completeSale` now opens a per-bill Dexie scope: base stores plus only what the bill writes (`udhaar`, tracked movements, payments, audits, or a reissue). `products`, `shop` and `staff` stay read-only, and `products` is no longer reported to local-write listeners on every sale.
- Sale lines, stock movements, payments and audit rows are written with one `bulkAdd` and one outbox `bulkAdd` each through `Writer.insertMany`; stock movements update `stock_levels` in one batched pass instead of two requests per line.
- `useCatalogueRows` sorts once in Sell order and patches only the products whose level changed plus the bundles whose recipe uses them, so a shop with any bundle no longer rebuilds 5,000 rows and haystacks after every bill.
- Search cache invalidation is split: a sale/refund/void clears only the invoice fallback, not the 5k product/customer catalogue cache that every keystroke reads.

### Snapshot and enrolment throughput — 21 Nov 2026 review
- Snapshot pages no longer maintain `stock_levels`/`party_balances` row by row; the caches are rebuilt once when the download completes, removing hundreds of thousands of redundant cache writes (and their reads) from a large enrolment.
- `mergeRows` short-circuits an empty outbox instead of loading two empty arrays on every page, and a snapshot transaction locks only the tables it writes.
- The next snapshot page is fetched while the current page is written to IndexedDB, and `applyStatus` runs once per snapshot run instead of three `kv` reads per page.
- A restore recovery skips the snapshot-end cache rebuild and lets the recovered-outbox replay rebuild once, so `stock_movements` and `ledger_entries` are no longer scanned twice back to back.

### Reports, refund dates and export streaming — 21 Nov 2026 review
- `refund_lines` now carries a till-only `business_date` (Dexie V10), backfilled from each refund on upgrade and re-derived when a server row is merged. It is stripped from pushed ops and never stored in D1.
- `summary`, `soldByProduct`, `productDetail` and `reportBundle` read refund lines by date range instead of scanning the table once a busy window crosses 100/200 refunds; `reports.ts` `byIds` always uses chunked `bulkGet`, and statement pages keep their `sale_lines`/`purchase_lines` lookups bounded to the page.
- Device and server exports cache both `Intl.DateTimeFormat` instances per shop time zone and stream every device table in 5,000-row primary-key pages (server tables page by page) into Blob-backed zip entries, so a 440k-line table no longer needs one row array plus full JSON and CSV strings in memory at once.

### Sync and push D1 throughput — 21 Nov 2026 review
- The device-token lookup joins today's `tenant_usage` row, so pull, push, snapshot, `/me` and the shop export read the usage counters in the same D1 query instead of a second round trip.
- `GET /api/sync/pull` reads the `change_log` page and the tenant's prune floor in one batch and embeds SQLite's stored `row_json` directly (only old clients parse rows for the bundle gate); a poll is two D1 round trips instead of four.
- Push lookups read the `shop` rules in the same batch, query `products` once over the union of stock and sale ids, and plan each transaction group against a copy-on-write avg-cost overlay instead of cloning the whole map.

### Chunk consolidation and Sell responsiveness — 21 Nov 2026 review
- Rolldown `codeSplitting` groups vendor families, all `$initial` shell modules into `app-shared`, and lazy source areas into `app-<area>` chunks; the build drops from 225 to 48 JS chunks, 10 initial files and 7 `modulepreload` tags, with initial JS still under the 290 KB gz budget.
- Sell filters on `useDeferredValue`, memoizes the product grid/tile and cart panel with stable callbacks, computes the three cart-tab totals once per cart/money change, computes the hold label only while the dialog is open, and no longer recreates the two `ResizeObserver`s on every result-count change.
- `check-bundle-size.mjs` now caps total JS chunks (60), initial JS files (12), `modulepreload` tags (8) and sub-1 KB chunks (10).

### PWA delivery — 21 Nov 2026 review
- Workbox no longer appends `?__WB_REVISION__=…` to content-hashed `/assets/*` entries, so a first visit does not download the initial JS/CSS graph twice.
- `/bikri/workbox-*.js` is immutable, while `sw.js`, `manifest.webmanifest` and `theme-init.js` revalidate without the broad `no-transform`, so Cloudflare can compress them; HTML keeps the beacon guard.
- `check-bundle-size.mjs` now fails if a hashed asset’s precache entry keeps a non-null Workbox revision.

### Print agent 0.1.5 — 21 Nov 2026
- `agent.log` rotates at 5 MB while the agent runs (one previous file), instead of only when it starts; the rate limiter drops expired buckets and compacts retained slices; a job clears `req.Data` after base64 decoding so the encoded payload is collectable during printing.
- Wizard download links, the installer default and the build fallback move to `print-agent-v0.1.5`. The agent protocol stays 1, so 0.1.4 agents keep working until updated.

### Print agent 0.1.4 — 21 Nov 2026
- The Windows print agent enumerates printers natively with `EnumPrintersW`/`GetDefaultPrinterW` instead of spawning PowerShell/CIM every 10 s, CUPS enumeration is singleflighted with a stale fallback, the dead completed-job `lpstat` call is removed, synchronous prints return `done` without a spool id, and the GDI path uses a top-down DIB from the existing RGBA buffer.
- Wizard download links, the installer default and the build fallback move to `print-agent-v0.1.4`. The agent protocol stays 1, so 0.1.3 agents keep working until updated.

### Admin, prune and device-code budget hardening — 21 Nov 2026 review
- Migration `0028` adds the server-only `branch_device_codes` registry (backfilled once from devices, code history and existing invoice numbers), drops the `sales_branch_invoice` index and adds `tenant_usage_day`. Device enrolment now reads a handful of branch codes instead of every invoice number in the branch, and reserves the chosen code.
- Operator purge skips empty tables with one probe and returns `remaining` as 0/1 instead of running two 29-table `COUNT(*)` batches on every 5k chunk; the console shows a plain "Purge in progress" note and detects a stuck purge from `deleted`.
- Restore import is capped at 250 rows per call and writes no `change_log` rows (the follow-up `restore-epoch` forces every till to snapshot), removing the multi-million-write / hundreds-of-MB bloat on a large restore.
- The nightly prune now reads today's account `rows_written`, stops before 90,000, chunks `applied_ops` in 5,000-row batches, probes empty tables once before tenant deletion, and logs the actual writes. A delete that runs out of budget resumes the next night.

### Performance P0 batch — 21 Nov 2026 review
- Migration `0027` adds the partial `sales_replaces` index so restore purge and nightly tenant deletion no longer scan every bill for each deleted reissue; the API perf suite now deletes 2,000 of 20,000 reissued bills and gates the plan, rows read and elapsed time.
- Reports slow movers read a bounded 30-day `sale_lines` range plus one indexed reverse seek per remaining candidate instead of walking every stock movement ever written; the Products tab receives the list from the coalesced report-worker bundle, so it never runs on the counter's main thread. A 1,000-candidate/20,000-line perf test guards the budget.
- Stock count renders a windowed list (only rows near the viewport are mounted), loads the 5,000 products once per count instead of on every draft change, and debounces the whole-draft `kv` write by 350 ms with a flush on hide, unmount and Finish; taps update the screen immediately.
- Print agent: Windows printer enumeration uses `EnumPrintersW`/`GetDefaultPrinterW` (no PowerShell per refresh), CUPS enumeration is singleflighted and serves the last known list on a transient error, the dead completed-job `lpstat` call is gone, a synchronous print returns `done` immediately when there is no spool id, the GDI path uses a top-down DIB from the existing RGBA buffer, and CI runs `go test -race ./...`.

### Visual design review fixes — 20 Nov 2026
- Graphite overlays use a semantic dark scrim instead of the inverted `bg-text/40`, modal panels get a border, and the dark payment mix gives Credit a violet distinct from Card.
- Command Palette rows span the dialog with the selected-row ink and a Lock icon; the Shops 768 px table fade is no longer reversed, and phone strips fade only an edge with hidden content.
- Urdu times are bidi-isolated, the Product detail Urdu subtitle aligns with the title stack, and bundle names/components use the Latin face when needed; `bundle_count`/`bundle_sold` are pluralised in all three locales.
- Settings keeps its `h2` semantics at the `h1` scale, Display aligns with its header and gets 44 px checkbox rows; Home's read-only card is a neutral action surface so the shell banner is the only amber warning, and Run the till uses three columns.
- Desktop Sell actions return to the documented 48 px; bundle tiles use a shorter left label, component costs are labelled, and embedded Bill detail drops the duplicate Qty/On bill lines and trails More after quiet Print.
- Product detail/form loading, router pending, page-level Admin error `h1` (tab errors keep the page heading), Backups error/inline manifest-error states and StatCard sizes, responsive `HourlyChart` labels, textarea padding, semantic step circles, card-title weights, rail geometry, token pairings, touch targets, toast placement and owner email/phone bidi isolation are fixed. The Product detail Urdu subtitle is now isolated in a page-direction paragraph, and the Reports active tab scrolls only its strip.

### CI security, tooling and docs hygiene — 20 Nov 2026 review, PR 8
- `deploy.yml` no longer exposes `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` to `pnpm install` or `pnpm build`; both secrets are attached only to the four Cloudflare steps.
- PR CI now runs `tools/check-migrations-safe.mjs` before build, so destructive D1 DDL is rejected before merge.
- `print-agent-release.yml` is read-only workflow-wide with `contents: write` only on the release job, uses the same `upload-artifact` SHA as the other workflows, and all pinned action SHAs carry version comments.
- E2E declaration output moves from `e2e/dist/` to the ignored `e2e/.tsbuild/`, stale scratch specs are removed, and temp-spec patterns are ignored.
- `check-bundle-size.mjs` fails closed on empty/missing output and uses `BASE_PATH`; `brand/**` stays out of the offline precache.
- `docs/04-api.md` drops duplicate/phantom endpoints, adds `files/gc` and `OWNER_EMAIL_MISSING`, and updates the version/schema examples; `docs/decisions.md` gains the PR #54 entry (D-265), the print-agent release becomes D-266, and D-242 is back in numeric order.
- Architecture/testing/printing docs replace stale Drizzle references, show `APP_VERSION` 1.1.0 and the `print_agent` CI job, list the Print Agent connection and `kv.printer` fields, and fix stale e2e/seed paths.

### POS UI/UX, accessibility and operator polish — 20 Nov 2026 review, PR 7
- Day-close denomination counts are whole numbers (Urdu/Arabic-Indic digits supported, no float paisa), and a synchronous ref plus a stable close id prevent double-clicks creating two closes. `ConfirmDialog` also disables its confirm button on the first click.
- Reports falls back to the main thread when its Web Worker fails to load or crashes, instead of staying on the loading spinner; report CSV/PDF exports surface failures.
- The supplier delivery PNG/PDF clamps the invoice number, right-aligns refund columns inside the page, and shows returned quantities; a blocked `sessionStorage` write after a delivery no longer shows a false failure.
- Global search now uses Radix Dialog (focus trap and focus return), and `/`/`?` no longer open over an active dialog; command-palette write commands are hidden in read-only shops, its combobox ARIA is valid, and Enter remembers the command.
- Enter/Escape handlers ignore IME composition across the shell, search and command palette.
- `MoneyInput` drops stale drafts on external value changes and only suppresses the first focus mouseup, so the caret can be placed normally.
- Refund/label dialogs initialise their selections once per open, so a background sync cannot reset a mid-edit choice; the customer statement pre-opens the WhatsApp tab, hides the phone-only jump button, and guards "Sell to" in read-only shops.
- The phone More menu closes on outside tap/Escape, and its idle callback is cancelled on unmount.
- Hard-coded admin/report/payment strings moved to the three catalogs; percent fields use the new integer `parsePercentToBp`, and PIN/last-4 inputs normalise Urdu/Arabic-Indic digits.
- Accessibility: semantic buttons replace interactive `<li>`/`<tr>`, the refund reason input is labelled, disabled fields are skipped on modal autofocus, and the report/tenant tablists have roving focus with Arrow/Home/End keys (the payment method is a radiogroup).
- Refund, supplier payment/return, customer receipt, delivery and delivery-export actions have synchronous double-submit locks.
- Six product/stock routes are lazy-loaded, cutting initial JS from 278.2 KB to 256.5 KB gz.
- `check-bundle-size.mjs` imports `BASE_PATH`, fails on empty/missing output, and the service worker no longer precaches `brand/**`.

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
- The desktop Today register is recomposed for the wide main column: a 20 px title, a 32 px sold figure with the bill count beside it, a credit row with given/received/credit-bills, the last-bill time in the title row, and a separate drawer footer on a subtle band with the “Expected · since last close” cash hint and a full-width Day close row. The phone credit-bill count is a horizontal label/value row, the count uses a lighter 18 px weight, and the bill-count pill drops its icon (D-249, D-250, D-252, D-253, D-255).
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
