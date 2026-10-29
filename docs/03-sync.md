# 03 — Sync

## 1. Principles

1. **Local first.** The till reads and writes only IndexedDB. The network is used only to exchange ops.
2. **Append-only money.** Ledger tables (see [02 §1.1](02-data-model.md#11-table-kinds)) never conflict: each row is created once on one device with a ULID.
3. **Idempotent push.** Every op has a ULID `op_id`; the server records applied op IDs and ignores repeats.
4. **One ordered change stream per database, read per tenant.** The server appends every applied change to `change_log` with an autoincrement `seq` and the tenant's `tenant_id`; a till pulls only its own tenant's rows by cursor (`seq` values of one tenant have gaps where other tenants' changes sit, which is fine).
5. **Server is the meeting point, not the authority for selling.** The server never rejects a valid sale because of stock or credit.
6. **A till belongs to exactly one tenant.** The tenant comes from the device token on every request (never from the body). Every read and write the sync handlers make is scoped to that tenant ([13 §5](13-multi-tenancy.md#5-tenant-scoping-rules-for-implementers)); the till's Dexie database holds only that tenant ([02 §3](02-data-model.md#3-dexie-schema-till)).

## 2. Op format

```ts
// packages/core/schemas/sync.ts (example)
// every op also carries tx_id: the outbox's transaction id (D-054), so the server can keep one user action together (read-only cutoff, 13 §7.2)
type Op =
  | { op_id: string; tx_id: string; tbl: LedgerTable; kind: 'insert'; row: Record<string, unknown> }
  | { op_id: string; tx_id: string; tbl: MasterTable; kind: 'upsert'; row: Record<string, unknown>;
      base_rev: number;            // 0 when creating
      changed_fields: string[] }   // fields the user changed (empty when creating)
  | { op_id: string; tx_id: string; tbl: MasterTable; kind: 'delete'; row_id: string; base_rev: number };
```

- `row` contains **all columns of the table known to that app version** except server-managed ones (`rev`, and `products.avg_cost`, which the server ignores on input). `row` never contains `tenant_id`; if it does, the server drops the key and uses the token's tenant.
- `kind: 'delete'` sets `deleted_at` (soft delete).
- Ops are validated with the table's Zod schema on both sides.
- Allowed `tbl` values: the master and ledger tables of [02 §1.1](02-data-model.md#11-table-kinds) only; any server-owned or unknown table → `rejected` / `UNKNOWN_TABLE`. On ledger inserts the server ignores client values for derived columns (`sales.status`).
- `change_log.op` is `upsert` for every insert or update (including a ledger row's first insert) and `delete` for soft deletes.

**Push result handling (client):** `applied` → delete the outbox entry; `conflict_merged` → delete it (the merged row arrives with the next pull); `rejected` → keep it with `status: 'failed'`, `last_error = error_code`, never auto-retried (Settings → Sync offers Retry after the user fixes the data, or owner Discard); ops missing from `results` → stay `pending`. HTTP 401 `DEVICE_REVOKED` → stop syncing ([§8](#8-device-revocation-and-data-loss-window)); 403 `TENANT_READ_ONLY` → enter read-only mode, keep every op pending ([13 §7.2](13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)); 409 → show "Update the app"; 413/5xx/network → backoff (§6), nothing changes locally.

## 3. Outbox

- Every repository write adds one outbox entry per row in the **same Dexie transaction** as the row itself: `{ seq (auto), op_id (ULID), tx_id (ULID shared by the transaction), tbl, kind, row_id, row, base_rev, changed_fields, created_at, status: 'pending', attempts: 0 }`.
- Several edits of the same master row while still pending are **coalesced**: the newer op replaces the older pending op's `row`, unions `changed_fields`, keeps the older `base_rev`.
- Every entry carries `tx_id` (one ULID per Dexie transaction, i.e. per user action). Entries are pushed in `seq` order, in batches of up to **200 ops** and **512 KB** of JSON, and a batch is only cut **between** transactions, so all rows of one action (a refund with its payment and ledger entry, an override with its audit row) always arrive in the same push. To guarantee that, no transaction may write more than 200 ops: bills, refunds, deliveries and supplier returns are limited to **60 lines** (≤ ~190 ops), product import writes chunks of 50 rows and bulk price update chunks of 100 products per transaction. The repository layer asserts this limit in tests.
- After a successful push, acknowledged entries are deleted (not kept) and `kv.last_push_at` is set.
- An entry rejected by the server (`result: 'rejected'`) stays with `status: 'failed'` and `last_error`; the rail sync badge turns red and Settings → Sync lists failed ops with the error and a "Discard" (owner only) or "Retry" action. Failed ops do not block later ops.

## 4. Protocol

API paths in this doc are relative to the `/bikri` base path (full URL `https://algovyn.com/bikri/api/...`, see [01 §1.1](01-architecture.md#11-url-layout-and-the-path-convention-used-in-these-docs)).

### 4.1 Push — `POST /api/sync/push`

Request:
```json
{
  "device_id": "01JC0Z8K3V7R1M2Q4S6T8V0X2Y",
  "schema_version": 1,
  "app_version": "0.1.0",
  "ops": [
    { "op_id": "01JC1A...", "tbl": "sales", "kind": "insert", "row": { "id": "01JC1A...", "invoice_no": "INV-A-1042", "...": "..." } },
    { "op_id": "01JC1B...", "tbl": "products", "kind": "upsert", "base_rev": 3, "changed_fields": ["price"], "row": { "id": "01J9...", "price": 155000, "...": "..." } }
  ]
}
```

Server algorithm (`apps/api/src/sync/applyOps.ts`). `T` = the tenant of the authenticated device; every statement below binds `tenant_id = T` (through `tenantDb`, [13 §5](13-multi-tenancy.md#5-tenant-scoping-rules-for-implementers)):
0. Tenant gate: tenant `status` must be `active` or `read_only` (`suspended` → `403 TENANT_SUSPENDED`; `maintenance` → `503 MAINTENANCE`); a push from a `support` device → `403 FORBIDDEN`; read today's `tenant_usage` row: at or above `daily_write_budget` → `503 TENANT_QUOTA` with `Retry-After` until 00:00 UTC ([13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)). The client keeps its ops in all these cases.
   - **Read-only cutoff** ([13 §7.2](13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080), D-080): if the tenant is `read_only` and the device's `read_only_seen_at` is NULL, every op in this push is eligible and `read_only_seen_at = now` is added to the batch. Otherwise only ops of transactions (`tx_id`) whose rows all have `created_at ≤ read_only_seen_at + 10 min` are eligible; the rest are not processed and are omitted from `results` (step 7), so they stay pending on the till. No eligible op → `403 TENANT_READ_ONLY`.
1. Reject if `schema_version` < server `MIN_CLIENT_SCHEMA` (Worker var) → `409 SCHEMA_OUTDATED` (client must update the app first; it keeps the ops). Clients with `MIN_CLIENT_SCHEMA ≤ schema_version ≤ SCHEMA_VERSION` are accepted, which is what makes additive migrations safe while old cached tills are still running ([09 §5](09-backups-and-ops.md#5-routine-operations)). `MIN_CLIENT_SCHEMA` is raised only when a migration is not backward compatible.
2. Validate the whole body with Zod; reject the batch on structural errors (`400`).
3. Look up which `op_id`s already exist in `applied_ops` (one `SELECT ... WHERE tenant_id = ?1 AND op_id IN (...)`, chunked by 100 because D1 allows 100 bound parameters). Those ops are answered `applied` without re-applying.
4. For each remaining op, build statements:
   - **insert (ledger):** `INSERT INTO <tbl> (tenant_id, ...) VALUES (?1, ...) ON CONFLICT(tenant_id, id) DO NOTHING`. A row whose references point at ids that exist only in another tenant fails the composite foreign keys and is `rejected` / `FOREIGN_KEY`. Check-constraint failures abort the batch (step 5) and end up as op `rejected` with `CONSTRAINT_FAILED`.
   - **upsert (master):** read current rows (one batched read before building writes). If absent → insert with `rev = 1`. If `current.rev == base_rev` → update **the columns present in `row`** (never columns the client did not send, so a till on an older schema cannot blank new columns), `rev = rev + 1`. If `current.rev != base_rev` → **merge**: update only `changed_fields`, `rev = rev + 1`, and insert a `sync_conflicts` row with `resolution = 'merged'`. Result `conflict_merged`.
   - **Optimistic guard (D1 has no interactive transactions):** every UPDATE carries `WHERE tenant_id = ?1 AND id = ?2 AND rev = ?<rev read in this request>`. After the batch, any guarded UPDATE whose `meta.changes = 0` means another push changed the row in between; re-read and re-apply that op once (as a merge), else leave it pending (step 7).
   - **delete (master):** set `deleted_at = now`, `rev = rev + 1` (no-op if already deleted).
   - Permission check per op ([05 §5](05-auth-and-roles.md#5-server-side-enforcement)); failure → `rejected` / `FORBIDDEN`.
   - Append `change_log (tenant_id, tbl, row_id, op, row_json, device_id, at)` with the row **as stored**, built inside the same batch with `INSERT INTO change_log (...) SELECT tenant_id, ?, id, ?, json_object('id', id, 'name_en', name_en, …all columns except tenant_id…), ?, ? FROM <tbl> WHERE tenant_id = ?1 AND id = ?` placed after the write (generated per table from `packages/db/src/tables.ts`; `json_object` takes at most 32 arguments per call in D1, so tables with more than 16 columns nest `json_patch(json_object(…), json_object(…))`).
   - Append `applied_ops (tenant_id, op_id, device_id, applied_at, result, error_code)`.
   - Side effects: recompute `sales.status` for refunds/voids; recompute `products.avg_cost` for movements with `unit_cost` ([07 §7](07-money-rules.md#7-cost-weighted-average)) and append their `change_log` rows; raise `devices.last_invoice_seq`.
5. Execute everything with `PRAGMA defer_foreign_keys = ON` followed by all statements in **one `db.batch()`** (atomic; a batch counts as one query against the free plan's **50 queries per Worker invocation** limit). If the batch fails as a whole (e.g. a CHECK or FK violation), **bisect**: split the failing ops in halves and retry each half as its own batch, recursively, until the bad op(s) are isolated and marked `rejected` (record the rejection in `applied_ops` so it is not retried). Stop when the request has used 40 D1 calls.
6. Usage: the last statement of every batch is `INSERT INTO tenant_usage (tenant_id, day, pushes, rows_written, rows_read) VALUES (?1, <UTC day>, 1, ?, ?) ON CONFLICT (tenant_id, day) DO UPDATE SET` the three counters `+ excluded.…`, with the rows the previous batches of this request reported in D1's `meta` (the counter lags by one batch; good enough for a budget).
7. Ops that were not processed (call budget exhausted, or a guarded update lost twice) are simply **omitted from `results`**; the client keeps them `pending` and sends them again on the next push. The response always lists results in the same order as the processed ops.

Response:
```json
{
  "results": [
    { "op_id": "01JC1A...", "result": "applied" },
    { "op_id": "01JC1B...", "result": "conflict_merged", "server_rev": 5 }
  ],
  "server_time": 1793050000000,
  "latest_seq": 48213,
  "tenant_status": { "status": "active", "since": null },
  "support": null
}
```

### 4.2 Pull — `GET /api/sync/pull?since=<seq>&limit=500`

```sql
SELECT seq, tbl, row_id, op, row_json FROM change_log WHERE tenant_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3;  -- index change_log_tenant_seq
```

If `since < tenants.change_log_floor` of the caller's tenant (those changes were pruned, [§4.4](#44-retention-pruning-and-stale-tills)), the server answers `410 SNAPSHOT_REQUIRED` with `details: { change_log_floor }` and the till runs a snapshot ([§4.3](#43-snapshot--get-apisyncsnapshot)) instead.

Response:
```json
{
  "changes": [
    { "seq": 48190, "tbl": "products", "op": "upsert", "row": { "id": "01J9...", "rev": 5, "avg_cost": 112000, "...": "..." } },
    { "seq": 48191, "tbl": "sales", "op": "upsert", "row": { "id": "01JC1A...", "status": "part_refunded", "...": "..." } }
  ],
  "next_since": 48191,
  "has_more": true,
  "server_time": 1793050000000,
  "restore_epoch": "1",
  "restore_point_at": 0,
  "poll_after_ms": 60000,
  "tenant_status": { "status": "active", "since": null },
  "support": null
}
```

`restore_epoch`, `restore_point_at`, `poll_after_ms`, `tenant_status` and `support` are the caller's tenant's values (`tenants` row); a restore, status change or support grant of one shop never disturbs the tills of another. The till saves `tenant_status` and `support` in `kv` and switches read-only mode and the banners on or off ([13 §7.2](13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080), [§7.5](13-multi-tenancy.md#75-operator-support-access-d-084)). If `restore_epoch` differs from `kv.restore_epoch` (the pull response also carries `restore_point_at`, epoch ms of the data the server was restored to), the client runs **restore recovery** before anything else:
1. Re-enqueue every ledger row **this device created** (`device_id` = own id) with `created_at ≥ restore_point_at` as fresh `insert` ops (new `op_id`s; the server ignores rows it already has via `ON CONFLICT(id) DO NOTHING`). Master rows are not re-sent (the restored server copy wins).
2. Keep the outbox; clear all synced tables and caches; run a snapshot ([§4.3](#43-snapshot--get-apisyncsnapshot)); then push the outbox.
3. Never lower the invoice counter: `kv.invoice_seq = max(kv.invoice_seq, max local sales.invoice_seq for this device, devices.last_invoice_seq)`, so no invoice number is ever issued twice.
4. Save the new `kv.restore_epoch`.

This turns the restore "loss window" into: only rows created on devices that no longer exist (or whose browser data was cleared) are lost. See [09 §3](09-backups-and-ops.md#3-restore-procedures).

Client merge (`apps/pos/src/sync/pull.ts`), one Dexie transaction per page:
- For each change, skip it if the row's `id` has a **pending** outbox op that is newer (local edit wins locally until the push result arrives; the next pull brings the merged row).
- Otherwise `put` the row (full replace). For ledger rows, also update `stock_levels` / `party_balances` caches **only if the row was not already present** (rows created on this device are already counted).
- A skipped server row is stored in local-only `pull_shadow` (`[tbl+id]` → row). When the pending op is acknowledged (`applied` / `conflict_merged`), delete the shadow: the server appends a newer `change_log` row for that push, which the next pull brings. When the op is `rejected` and later discarded, write the shadow row locally, so the till never keeps a value the server refused.
- Save `kv.pull_cursor = next_since`. If `has_more`, fetch the next page immediately.
- `devices` and `sync_conflicts` rows are also pulled (read-only on the till), so bills can show an over-refund warning and Settings → Sync can list conflicts offline.

Initial sync (new device, restore, or a till whose cursor is older than the prune floor) always uses the **snapshot** below, never `pull?since=0`, because `change_log` older than 30 days is pruned.

### 4.3 Snapshot — `GET /api/sync/snapshot`

A consistent-enough copy of every synced table, paged per table, followed by a normal pull from the snapshot's cursor.

1. `GET /api/sync/snapshot` (no query) → `200 { "snapshot_seq": 48213, "tables": [ { "tbl": "shop", "rows": 1 }, { "tbl": "products", "rows": 812 }, … ] }`. `snapshot_seq` = `MAX(seq) FROM change_log WHERE tenant_id = ?1` (or the tenant's `change_log_floor` if it has no log rows) read **before** any rows; `rows` are `COUNT(*) … WHERE tenant_id = ?1` per table for the progress bar (all counts in one `db.batch()`). Tables, in this order (parents before children): `shop`, `branches`, `devices`, `staff`, `categories`, `products`, `product_barcodes`, `customers`, `suppliers`, `expense_categories`, `promises`, then every ledger table of [02 §1.1](02-data-model.md#11-table-kinds), then `sync_conflicts`. Soft-deleted master rows are included (history refers to them). `devices` rows exclude `token_hash`. No row carries `tenant_id`.
2. For each table: `GET /api/sync/snapshot?tbl=<tbl>&after=<id>&limit=500` → `200 { "tbl": "products", "rows": [ {…}, … ], "next_after": "01J9…", "has_more": true }` from `SELECT <columns except tenant_id> FROM <tbl> WHERE tenant_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3` (primary key `(tenant_id, id)`) (`limit` 1–1000). Rows have exactly the shape of `change_log.row_json`.
3. The till writes each page in one Dexie transaction with the **same merge rules as pull** (§4.2: rows with a pending outbox op are skipped into `pull_shadow`; nothing is deleted), and saves progress in `kv.snapshot_state = { snapshot_seq, tbl, after }` so an interrupted snapshot resumes where it stopped (also after a reload). Selling keeps working during a snapshot: the till's existing data stays in place and is only overwritten row by row.
4. When all tables are done: rebuild `stock_levels` and `party_balances` (02 §3.2), set `kv.pull_cursor = snapshot_seq`, delete `kv.snapshot_state`, set `kv.last_full_sync_at`, then pull normally. Changes written while the snapshot was running have `seq > snapshot_seq`, so the pull re-applies them in order; pages read later may already contain newer rows, which the pull simply rewrites with the same or newer values.

Progress UI: full-screen on a new device ("Downloading shop data… 12,400 of ~30,000 rows"), a non-blocking banner on a till that already has data. Cost: one Worker request per 500 rows; a 300,000-row shop is ~600 requests and 300,000 D1 rows read (inside the daily free limits, but 6 % of the account's read budget: snapshots of large shops count against the shared budget, [13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)).

### 4.4 Retention, pruning and stale tills

A Worker **Cron Trigger** (`"triggers": { "crons": ["0 22 * * *"] }` = 03:00 Asia/Karachi (30 minutes after the 02:30 backup export); 1 of the account's 5 free cron triggers) runs `apps/api/src/cron/prune.ts` in the Worker's `scheduled()` handler:

The prune covers **all tenants in one run** (still one cron trigger), with per-tenant floors, and stays within the Free plan's 50 D1 queries per invocation by stopping after 40 calls and continuing the next night:

1. `cutoff = now − 30 days`. Targets for every tenant in one query: `SELECT tenant_id, MAX(seq) AS target FROM change_log WHERE at < ?cutoff GROUP BY tenant_id` (index `change_log_at`).
2. Per tenant, delete in chunks, each chunk one `db.batch()` that also moves that tenant's floor: `DELETE FROM change_log WHERE tenant_id = ?t AND seq > ?floor AND seq <= ?upto` (`upto` = the 5,000th seq above the floor, capped at `target`) + `UPDATE tenants SET change_log_floor = ?upto WHERE id = ?t`. At most 50,000 rows per night across tenants; tenants are served round-robin from where the last run stopped (`meta.prune_cursor`), so one big shop cannot starve the others.
3. `DELETE FROM applied_ops WHERE applied_at < now − 90 days` (index `applied_ops_at`, chunked by `rowid`, up to 20,000 per run so ten reference shops keep the 90-day window). Applied-op IDs are kept 3× longer than the change log so a till that was offline for weeks and re-sends ops whose acknowledgement it never received is still answered from `applied_ops`; ledger inserts would be harmless anyway (`ON CONFLICT(tenant_id, id) DO NOTHING`).
4. `DELETE FROM enrolment_codes WHERE expires_at < now − 1 day`; `DELETE FROM owner_email_codes WHERE expires_at < now − 1 day`; `DELETE FROM tenant_usage WHERE day < <today − 90 days>`. For tenants whose `support_until` has passed and that still have non-revoked support devices: revoke them and write `support_access_end` (`ended_by: 'expiry'`) if no `/api/me` call did it first ([13 §7.5](13-multi-tenancy.md#75-operator-support-access-d-084)). `sync_conflicts`, `audit_log` and all ledger and master rows are never pruned.
5. Tenant deletion ([13 §7.4](13-multi-tenancy.md#74-delete-a-tenant)): for tenants with `status = 'deleting'`, delete their rows child tables first (`DELETE FROM <tbl> WHERE rowid IN (SELECT rowid FROM <tbl> WHERE tenant_id = ?t LIMIT 2000)`), at most 20,000 rows per night in total, and their R2 objects under `t/<tenant_id>/` (list + delete). When every table is empty, set `status = 'deleted'`, `deleted_at = now`.
6. Set `meta.last_prune_at`; log counts per tenant (Workers Logs). The cron uses only I/O (no CPU-heavy work), within the 10 ms CPU limit; rows deleted count as D1 rows written and are charged to the account's shared budget, not to a tenant's `daily_write_budget`.

**A till offline for more than 30 days** keeps selling normally (everything is local). When it comes back online:
1. If the server answers `409 SCHEMA_OUTDATED`, the PWA update is applied first (the rail already shows "Update ready"; it reloads when no cart is open).
2. It **pushes its outbox first** (push never depends on the pull cursor), so its own sales reach the server.
3. Its pull gets `410 SNAPSHOT_REQUIRED` → it runs the snapshot (§4.3) as a background banner ("Bringing this till up to date… 45%") and then continues pulling. No local data is cleared; pending local edits are protected exactly as in a pull.
4. Home warns early: no successful pull for **7 days** → amber card "This till hasn't received updates for 7 days"; for **25 days** → red card "Connect to the internet within 5 days to avoid a full re-download". These are warnings only; nothing stops working.

## 5. Conflict rules

| Data | Rule |
|---|---|
| Ledger rows (sales, lines, payments, refunds, voids, ledger entries, stock movements, purchases, expenses, cash moves, day closes, audit) | No conflicts possible: created once with a ULID; duplicates ignored by `op_id` and `ON CONFLICT(id) DO NOTHING`. |
| Master rows | Optimistic `base_rev`. Same rev → full update. Different rev → field-level merge of `changed_fields` (last pushed wins per field); recorded in `sync_conflicts`. |
| `products.avg_cost` | Server-owned. Client values are ignored on push; tills receive the server value on pull. |
| `products.last_cost` | Set by the delivery recipe as a normal `upsert` with `changed_fields: ['last_cost']`. |
| `sales.status` | Derived; recomputed on both sides; never pushed as a change. |
| Stock count | Stored as a delta (`count` = counted − on-hand at that moment on that device), so concurrent offline sales elsewhere still add up correctly. |
| Invoice numbers | `<bill_prefix>-<device_code>-<seq>`, `seq` comes from `kv.invoice_seq` (last issued number on this device; next bill uses +1). Set to `devices.last_invoice_seq` on enrolment (0 for a new device) and **never decreased** (restore recovery above). Two devices of a shop can never produce the same number because device codes are unique per branch and never reused; numbers are unique per tenant (`UNIQUE (tenant_id, invoice_no)`), so two shops may both have `INV-A-1`. |
| Staff, branches, shop, devices | Owner-only edits (server rejects others). `devices` is server-owned. |
| Deletes vs. edits | A delete always wins over a concurrent edit (row stays soft-deleted; the edit's fields are applied but `deleted_at` stays set). |
| Unique conflicts (same SKU or barcode created on two devices offline) | Second op is `rejected` with `UNIQUE_VIOLATION`; the till shows it in Settings → Sync and on the product with "Change SKU/barcode and retry". |
| Negative stock | Allowed. Products with on-hand < 0 appear in Reports → Stock exceptions. |
| Over-refund / refund-after-void (two tills act on the same bill offline) | Both rows are **accepted** (the money already left a drawer — real events are never rejected). The server records a `sync_conflicts` row (`kind = 'over_refund'` or `'refund_after_void'`, with both row IDs); the shop owner sees it in Settings → Sync → Conflicts and on the bill, and settles it manually (e.g. a pay-in). |
| Over-return to a supplier (more returned against a delivery line than was received) | Accepted, `sync_conflicts` `kind = 'over_return'`, shown in Settings → Sync → Conflicts. |
| Credit limit exceeded on two devices offline | Allowed (limit is a warning unless `hard_limit`); the second device's sale still syncs. |

## 6. Scheduling

| Trigger | Action |
|---|---|
| After any local write | debounce 5 s, then push |
| Every 60 s while visible and online | push (if pending) then pull |
| `online` event | push then pull |
| `visibilitychange` → visible | pull |
| Day close saved | push + pull immediately; show result in the day-close success view |
| Manual "Sync now" (rail badge menu) | push + pull |
| Push/pull HTTP error | exponential backoff: 5 s, 15 s, 60 s, 5 min (max); reset on success |

No Background Sync in v1: pushes happen only while the app is open (the counter PC keeps Bikri open all day).

**Clock check:** every response carries `server_time`. If `|device clock − server_time| > 5 min`, the rail shows "This PC's clock is wrong — fix the date/time" (amber) and Home shows an attention card. Ledger rows still use the device clock (`created_at`, `business_date` in `shop.timezone`), because selling must work offline; the warning stops a wrong clock from silently putting bills on the wrong business date.

**Pending report:** every till request sends `X-Bikri-Pending: <pending_op_count>;<oldest_pending_created_at or 0>`; the Worker stores it in `devices.pending_ops` / `devices.oldest_pending_at` together with `last_seen_at` (at most once per 5 minutes) for Settings → Devices and the operator console.

## 7. Status shown to the user

The rail badge (bottom of the rail) shows one of:

| State | Badge | Detail on hover/tap |
|---|---|---|
| synced | green dot | "Synced 2 min ago · 0 waiting" |
| pending | amber dot + count | "12 changes waiting · last sync 14 min ago" |
| offline | grey cloud-off | "Offline · 12 changes saved on this device" |
| error | red dot | "Sync problem: <message> · Open details" |
| outdated | blue arrow | "Update the app to keep syncing" (on `SCHEMA_OUTDATED`) |
| downloading | blue spinner + % | "Downloading shop data… 45%" (snapshot running, §4.3) |
| read-only | grey lock | "This shop is read-only · n changes waiting" (`tenant_status = read_only`; pulls continue, new changes are blocked, [13 §7.2](13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)) |

If pending ops are older than 24 h, Home shows a warning card: "This till hasn't synced since <time>. Connect to the internet so your data is backed up."

## 8. Device revocation and data loss window

A revoked device gets `401 DEVICE_REVOKED`; it stops syncing, shows "This device was removed by the owner", and offers "Export unsynced data" (`bikri-unsynced-<device_code>-<YYYYMMDD-HHmm>.json`: `{ format: 'bikri-unsynced', version: 2, tenant_id, device_id, ops: [...] }`) so nothing is silently lost. The shop owner imports that file on an **admin device** in **Settings → Devices → Import unsynced ops** (`POST /api/shop/import-ops`), or the operator in the console (`POST /api/admin/tenants/:id/import-ops`); not through a normal push, because the till push path rejects rows whose `device_id` is not the caller's ([04 §5](04-api.md#5-server-side-checks-beyond-zod)). Both endpoints accept ops only for a **revoked** device **of the same tenant** (a `device_id` of another tenant → `404 NOT_FOUND`), keep the original `op_id`s (so a second import is a no-op) and validate them exactly like a push.

## 9. Test cases (must exist in `apps/api` and `apps/pos` tests)

1. Same push sent twice → second response all `applied`, no duplicate rows, `change_log` unchanged.
2. Two devices edit product price offline (base_rev 3) → both pushes succeed, final price = last pushed, `sync_conflicts` has 1 row, both devices converge after pull.
3. Device A edits price, device B edits name, both from rev 3 → final row has both changes.
4. Device A deletes product, device B edits it → row stays deleted.
5. Sale referencing a customer created in the same batch, ops in reverse order → batch succeeds (deferred FKs).
6. Push with one invalid op (bad CHECK) among 10 → 9 applied, 1 rejected.
7. Push with schema_version 0 when server is 1 → 409, outbox unchanged.
8. Pull with 1,200 changes → 3 pages, cursor ends at max seq, local caches correct.
9. Offline for 3 days with 400 sales, then reconnect → all ops pushed in batches of ≤ 200 ops (about 16 requests), stock levels match server-computed sums.
10. Stock count on device A while device B sells offline → final on-hand = counted − B's sales after the count.
11. Push of 200 ops with 2 invalid ops at positions 17 and 150 → bisection isolates both as `rejected`, the other 198 are `applied`, and the request makes ≤ 40 D1 calls.
12. Two pushes for the same product arrive concurrently with the same `base_rev` → exactly one full update; the other becomes a guarded-update miss and is re-applied as a merge (`rev` ends at base + 2, one `sync_conflicts` row).
13. Restore recovery: server restored to a point before 3 sales of device A were synced; after the new `restore_epoch`, device A re-sends them, the server has all 3, and A's next invoice number is higher than any it issued before.
14. A till on `schema_version = SCHEMA_VERSION − 1` (≥ `MIN_CLIENT_SCHEMA`) pushes a product upsert without a newly added column → accepted, the new column keeps its value.
15. Import of a revoked device's unsynced-ops file through `/api/shop/import-ops` (admin device) or `/api/admin/tenants/:id/import-ops` → applied with original `op_id`s; importing it twice changes nothing; the same ops pushed with another till's token → `FORBIDDEN`; the file imported by another tenant's admin device → `404`.
16. Prune: with `change_log` rows of two tenants older and newer than 30 days, running `scheduled()` deletes only the old ones, sets each tenant's `tenants.change_log_floor` to the highest `seq` deleted **for that tenant**, and removes `applied_ops` older than 90 days only; a second run the same night deletes nothing; a pull of tenant B is not sent `410` because of rows pruned for tenant A.
17. Pull with `since` below `change_log_floor` → `410 SNAPSHOT_REQUIRED`; the till runs the snapshot and ends with the same row set and caches as a till that never went offline (compare table by table).
18. Snapshot interrupted after 2 of 25 tables (network off) and the app reloaded → resumes from `kv.snapshot_state`, no row downloaded twice into a wrong state, pending local edits kept (`pull_shadow`).
19. Till offline 35 days with 300 sales in the outbox → on reconnect it pushes all 300 first, then snapshots, then pulls; server and till agree on stock and balances.
20. Rows written by another till while a snapshot is running (after `snapshot_seq`) are present on the snapshotting till after its first pull.
21. Tenant isolation of sync (also part of [10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory)): tenants A and B both create a product with the same ULID and an `INV-A-1` sale → both applied, each tenant pulls only its own rows; a pull or snapshot with B's token never returns an A row; a B push of a sale referencing A's customer id → `rejected` / `FOREIGN_KEY`; a B upsert with A's product id creates or edits only B's row; a `tenant_id: "A"` key inside a B row is ignored.
22. Restore epoch per tenant: a new `restore_epoch` on tenant A triggers restore recovery on A's tills only.
23. Quota: tenant A at its `daily_write_budget` gets `503 TENANT_QUOTA` and keeps its ops; tenant B's push in the same minute is applied.
24. Read-only cutoff: tenant A made read-only while device A1 is offline with 30 sales → A1's first push applies all 30 and the response carries `read_only`; A1 then refuses new sales locally; a forged later push from A1 with a sale created 1 hour after `read_only_seen_at` → that op is omitted from `results` (stays pending) and a push with only such ops gets `403 TENANT_READ_ONLY`; a refund whose `payments` row is in the same `tx_id` is never split; pull and snapshot keep working; after reactivation the held-back op is applied.
25. Support devices: a push or file upload from a `kind = 'support'` device → `403 FORBIDDEN`; pull and snapshot work; after `expires_at` the token gets `401 DEVICE_REVOKED`.


**In-flight ops and restore recovery.** The client marks a pushed batch `sending`; a till never coalesces a new edit into it, and a transport failure returns it to `pending`. Discarding a rejected transaction also removes its local rows and rebuilds the caches. Restore recovery re-sends the child lines of every recovered sale, refund, purchase and supplier return, not just the headers. A sale invoice keeps its original bill prefix (the device code and suffix are still checked; uniqueness is the guard).

**Read-only cutoff and pull quarantine.** Each pushed op carries its outbox `created_at`; a read-only shop accepts a transaction only when its ops were queued inside the grace window, including deletes and master-data edits. A device enrolled while the shop is read-only starts with `read_only_seen_at = now`. If one pulled row cannot be written, the till retries the page row-by-row, records the failure under `kv.pull_errors` (shown in Settings → Sync) and advances the cursor so the rest of the shop keeps syncing.
