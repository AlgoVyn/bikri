# 09 — Backups and operations

Goal (REQ-B13, REQ-C13): the platform operator can always get **all** data out, restore the whole deployment or **one shop** without touching the others, and no single provider failure loses more than one day of synced data; each shop owner can export their own shop. Unsynced data lives on the tills until pushed.

There is still **one** nightly backup of the whole database (all tenants): a private R2 copy, plus an off-Cloudflare copy encrypted with the **operator's** `age` key; shop owners never handle that key. Per-tenant export, restore and deletion work logically on top of it (§3.4, §3.5).

## 1. Layers of protection

| Layer | What | RPO | Where |
|---|---|---|---|
| 1. Tills (IndexedDB, persisted storage) | Every record, immediately | 0 for that device | each browser |
| 2. D1 live | Synced data | ≤ 60 s while online | Cloudflare |
| 3. D1 Time Travel | Point-in-time restore of the **whole** DB (every shop) | any minute, last 7 days (free plan) | Cloudflare; disaster only (§3.1) |
| 4. Nightly export to R2 | `wrangler d1 export` SQL, gzipped | 24 h | R2 `bikri-backups/d1/` (separate bucket, never reachable by the till file API) |
| 5. Off-Cloudflare copy | same file encrypted with `age` | 24 h | GitHub Actions artifact (90 days) + optional owner Google Drive |
| 6. Shop owner manual export | JSON + CSV zip of **their shop** from Settings → Backup, built from the device's data, or from the server copy (`Download from server`, owner email sign-in, once per 24 h, [13 §7.3](13-multi-tenancy.md#73-per-tenant-export-and-restore)) | on demand | owner's PC/phone |
| 6b. Operator per-shop export | the same zip, built from the server copy in the console (§3.4) | on demand | operator's PC |
| 7. R2 files (logo, photos) | weekly full listing + copy of every object into the encrypted archive | 7 days | GitHub Actions artifact (90 days), `age`-encrypted |

## 2. Nightly backup workflow (`.github/workflows/backup.yml`)

Schedule `cron: "30 21 * * *"` (UTC) = **02:30 Asia/Karachi** daily; also `workflow_dispatch`.

Steps:
1. Checkout, setup Node 24, `pnpm i --filter tools`.
2. `wrangler d1 export bikri --remote --output=bikri-YYYY-MM-DD.sql` (date in Asia/Karachi).
3. Sanity check: file > 1 KB and contains `CREATE TABLE sales`; row counts per tenant via `wrangler d1 execute bikri --remote --json --command "SELECT tenant_id, count(*) FROM sales GROUP BY tenant_id"` etc. written to `manifest.json` `{ date, tenants: { <tenant_id>: { slug, status, tables: { sales: 20311, … } } }, sha256 }` (the hash of the uploaded `.sql.gz`).
4. `gzip -9` → upload to R2 bucket `bikri-backups`: `d1/YYYY-MM-DD.sql.gz` + `d1/YYYY-MM-DD.manifest.json` (`wrangler r2 object put bikri-backups/d1/… --remote`).
5. Encrypt `age -r $BACKUP_AGE_RECIPIENT` → upload as workflow artifact `backup-YYYY-MM-DD` (retention 90 days).
6. Retention in R2: keep 30 daily, 12 monthly (1st of month); delete older (script lists and deletes).
7. On failure: GitHub sends the default failure email to the repo owner; the operator console Overview shows "Last backup: 2 days ago" in red when the newest manifest is > 36 h old.

Free-tier impact: one export per night is a few hundred thousand rows read (≪ 5 M/day) and ~3 Class A R2 ops.

A running `wrangler d1 export` **blocks all other queries on the database** (Cloudflare D1 import/export docs), so it runs at 02:30 PKT when the shop is closed; a till that pushes during the export gets an error and simply retries with backoff. D1 cannot export databases that contain virtual tables (e.g. FTS5), so **never add virtual tables** to the schema (product search is done on the till in Dexie).

The repo is public, so GitHub Actions artifacts can be downloaded by other GitHub users: that is why the off-Cloudflare copy is always `age`-encrypted before upload; never upload the plain `.sql.gz` as an artifact.

The `age` private key is generated once by the **platform operator** (`age-keygen`), kept offline (printed + password manager); only the public recipient is a GitHub secret (`BACKUP_AGE_RECIPIENT`). It is one key for the whole deployment: shop owners never create or hold one, and adding a shop changes nothing here. The operator can therefore decrypt every shop's data; shop owners are told so in the terms and privacy notes (§6.1).

### 2.1 Weekly file backup (`.github/workflows/files-backup.yml`)

The nightly export covers D1 rows only; shop logos and product photos live in the separate
`bikri-files` bucket (keys `t/<tenant_id>/…`) and are not inside the SQL dump. A separate weekly
workflow copies them:

1. `tools/backup/files.mjs` lists every object under `t/` through the Cloudflare R2 API
   (`GET /accounts/{id}/r2/buckets/bikri-files/objects?prefix=t/`), follows the cursor and
   downloads each object (`GET …/objects/{key}`) with bounded concurrency and retries.
2. It writes `files/` mirroring the keys and `files-YYYY-MM-DD.manifest.json`
   (`{ format: "bikri-files", version: 1, date, objects, bytes, tenants: { <id>: { objects, bytes } }, files: [{ key, bytes, sha256, etag }] }`).
   It fails rather than uploading a partial archive, and its logs contain counts only — never
   keys or tenant ids.
3. The workflow tars the tree, encrypts it with `age` and uploads `files-YYYY-MM-DD.tar.gz.age`
   as an artifact (90 days). The plain archive never leaves the runner. The same
   `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `BACKUP_AGE_RECIPIENT` secrets are used;
   the token needs R2 read on `bikri-files`.

It runs at **22:45 UTC Sunday** (03:45 Asia/Karachi Monday), after the nightly D1 export. Each
archive is a full copy (not a delta) so it restores on its own; the bucket holds images only
(≤ 2 MB each), so the archive is small. If it grows into gigabytes, revisit the cadence or add
incremental archives before extending retention.

## 3. Restore procedures

### 3.1 Whole-database rollback in the last 7 days (Time Travel)

Time Travel restores the **entire** database in place, so it rolls back **every shop**. Use it only for a deployment-wide disaster (bad migration, mass corruption). To undo one shop's mistake use §3.4.

1. Find the time: the tenant's Activity (audit log) or the console.
2. `wrangler d1 time-travel info bikri --timestamp=2026-10-26T10:00:00+05:00` → bookmark.
3. **Stop tills from pushing**: set Worker var `MAINTENANCE=1` (`/api/sync/*` returns `503 MAINTENANCE`; tills keep selling offline and queue ops).
4. `wrangler d1 time-travel restore bikri --bookmark=<id>`.
5. Set a new restore epoch and the restore point (never increment, a restored DB carries its own old value):
   ```sql
   UPDATE tenants SET restore_epoch = CAST(<now_epoch_ms> AS TEXT), restore_point_at = <restore_point_epoch_ms>;   -- every tenant
   ```
   Tills see the new epoch on next pull and run **restore recovery** ([03 §4.2](03-sync.md#42-pull--get-apisyncpullsinceseqlimit500)): re-send their own ledger rows created after the restore point, full re-pull, then push the outbox; invoice counters never go backwards.
6. Unset `MAINTENANCE`.

Note: rows created after the restore point are re-sent by the tills that created them; only master-data edits made after the restore point, and rows from tills that no longer exist or whose browser data was cleared, are lost. Warn every affected shop owner before step 4 (count of `change_log` rows per tenant after the bookmark).

### 3.2 Restore a nightly backup to a new database

1. `wrangler d1 create bikri-restore`; `gunzip`; `wrangler d1 execute bikri-restore --remote --file=bikri-YYYY-MM-DD.sql`.
2. Verify counts against `manifest.json`.
3. Point the `DB` binding to the new database ID in `wrangler.jsonc`, deploy, then set `restore_epoch` / `restore_point_at` for every tenant exactly as in §3.1 step 5 (restore point = the backup's `manifest.json` `date` at 02:30 PKT).
4. **Restore drill:** before v1.0.0 and then every 3 months, restore last night's backup into `bikri-restore` and compare `manifest.json` counts (checklist item in [10 §6](10-testing.md#6-manual-hardware-checklist-before-each-release)); delete the drill DB afterwards.

### 3.3 Restore from the owner's JSON export (new deploy / leaving Cloudflare)

Settings → Backup → `Restore from export` is only enabled when the server reports an empty shop (`shop_setup_completed = false`, 0 sales) — e.g. a new tenant created for a shop moving from another Bikri deployment. The till uploads in batches via normal sync push (ops with original IDs), so the same validation applies. Format: `bikri-export-<slug>-YYYYMMDD-HHmm.zip` containing `manifest.json` (`{ format: "bikri-export", version: 2, exported_at, app_version, tenant: { id, display_name }, tables: {name: count} }`), `json/<table>.json` (array of rows exactly as in 02 without `tenant_id`, money in paisa) and `csv/<table>.csv` (human-friendly: amounts in rupees with 2 decimals, dates ISO in Asia/Karachi). The JSON is the restore source; CSV is for Excel.

### 3.4 Restore one tenant

Never with Time Travel (§3.1). Logical, from the console ([04 §3.7](04-api.md#37-operator-endpoints-cloudflare-access)):

1. **Get the shop's data** as a `bikri-export` zip, from one of: the operator console export (current server state), the shop owner's on-device export, or a nightly backup: `wrangler d1 create bikri-restore` (counts against the 10-database Free limit; delete it afterwards), load the backup into it (§3.2 step 1), then `node tools/backup/tenant-extract.mjs --db bikri-restore --tenant <id> --backup-date YYYY-MM-DD --out export.zip` (pages each table with `wrangler d1 execute --json … WHERE tenant_id = ?`).
2. Console → tenant → `Restore` → `maintenance on` (only this shop's tills get `503 MAINTENANCE` and keep selling offline).
3. `purge` until nothing is left (≤ 5,000 rows per call; deletes count as rows written, so a large shop may take several calls and should be restored outside the shop's busy hours).
4. `import` the zip (≤ 500 rows per call, parents first; rows validated like a push; `change_log` written).
5. `restore-epoch` with the restore point (the export's `exported_at` or the backup's date at 02:30 PKT) → the shop's tills run restore recovery ([03 §4.2](03-sync.md#42-pull--get-apisyncpullsinceseqlimit500)) and re-send their own newer ledger rows.
6. `maintenance off`. Audit `tenant_restore` in the tenant. Other shops are never touched.

### 3.5 Delete one tenant

[13 §7.4](13-multi-tenancy.md#74-delete-a-tenant): offer a final export, then `delete` (type the slug); devices are revoked immediately, rows and R2 files are removed by the nightly cron ([03 §4.4](03-sync.md#44-retention-pruning-and-stale-tills)), the `tenants` row stays as a tombstone. Copies remain in encrypted backups until they age out (30 days daily, 12 months monthly, 90 days GitHub artifacts, 90 days weekly file archives); the owner accepted this retention (D-083), and deleting a shop does not shorten it.

### 3.6 Restore files from the weekly archive

1. Download the `files-YYYY-MM-DD` artifact and decrypt it:
   `age --decrypt --identity <operator key> -o files-YYYY-MM-DD.tar.gz files-YYYY-MM-DD.tar.gz.age`.
2. Extract it: `tar -xzf files-YYYY-MM-DD.tar.gz` (the tree starts at `files/t/…`).
3. Compare every extracted file with `files-YYYY-MM-DD.manifest.json` (`bytes` and `sha256`)
   before uploading.
4. Upload the objects back to `bikri-files`, keeping the `t/<tenant_id>/…` keys, e.g.
   `wrangler r2 object put "bikri-files/t/<tenant_id>/shop/logo-<sha>.png" --file=… --remote`
   (or `rclone copy files/ r2:bikri-files --s3-no-check-bucket`).
5. Restore the matching D1 rows separately (§3.2 or §3.4); the rows only reference keys, so
   files can be restored before or after the rows.

## 4. Monitoring and limits

- `GET /api/health` (no auth) returns the shape in [04 §3.1](04-api.md#31-get-apihealth) (`db` is the result of `SELECT 1`); the operator can add a free uptime monitor on `https://algovyn.com/bikri/api/health`.
- Operator console Overview: D1 size vs 500 MB, account-wide rows written/read today (Σ `tenant_usage`) vs 100k / 5M, per-tenant usage vs `daily_write_budget`, Σ budgets vs the 70 % Bikri share, last backup age, last prune, tenants by status. Tenant detail: devices with pending ops and oldest unsynced op (`devices.pending_ops` / `oldest_pending_at`, from the `X-Bikri-Pending` header, [03 §6](03-sync.md#6-scheduling)).
- Shop owner (Settings → Devices / Sync): their devices, pending ops, conflicts, and "Today's sync budget: 62 %" from `/api/me`.
- Warnings at 70 % of any account limit or of a tenant budget; at 90 % of a tenant budget its `poll_after_ms` doubles; at 100 % its pushes get `TENANT_QUOTA` ([13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)). Red "Consider Workers Paid ($5/month)" when the account stays above 70 % for 3 days.
- Logs: `console.log` JSON lines `{ level, route, tenant_id, device_id, op_count, ms, error_code }`; view with `wrangler tail` or Workers Logs (observability enabled in `wrangler.jsonc`, sampling 10%). Never log tokens, enrolment codes, PIN hashes, phone numbers or customer names.

## 5. Routine operations

| Task | How |
|---|---|
| Deploy | merge to `main` → CI runs tests (including the isolation suite) → website check ([01 §5.5](01-architecture.md#55-release-gate-a-clean-algovyncom-decision-d-049)) → `wrangler d1 migrations apply bikri --remote` (and each shard) → `wrangler deploy` |
| Add a shop | console → Tenants → New → send the owner pairing code ([13 §7.1](13-multi-tenancy.md#71-onboarding-a-new-shop-d-072)) |
| Make a shop read-only (e.g. unpaid) / suspend / reactivate | console → tenant → `Make read-only` / `Suspend` / `Reactivate`, with a reason; recorded in the shop's Activity ([13 §7.2](13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)) |
| Help a shop (support access) | console → tenant → `Support access` (reason, 1–24 h) → open the code in a separate browser profile; the shop sees a banner until it ends ([13 §7.5](13-multi-tenancy.md#75-operator-support-access-d-084)) |
| Add or change a shop owner's email | console → tenant → Edit → owner email, then Cloudflare → Email Routing → Destination addresses → add it; the owner clicks the verification email ([05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082)) |
| Raise a shop's budget | console → tenant → daily write budget (keep Σ ≤ 70,000 on Free) |
| Sync log retention | automatic: nightly cron deletes `change_log` rows older than 30 days per tenant and `applied_ops` older than 90 days ([03 §4.4](03-sync.md#44-retention-pruning-and-stale-tills)); the console shows each tenant's `change_log_floor` and the last prune time |
| Rollback app | `wrangler rollback` (previous version); migrations are forward-only and additive (never drop/rename columns in v1) |
| New migration | `drizzle-kit generate` → review SQL (every new tenant table: `tenant_id`, `PRIMARY KEY (tenant_id, id)`, composite FKs, indexes leading with `tenant_id`) → commit `packages/db/migrations/000N_*.sql`; bump `SCHEMA_VERSION` for column/wire changes (not index-only ones) and the Dexie version when local data changes; must be backward compatible with the previous till version for 14 days ([01 §7.2](01-architecture.md#72-cicd)) |
| Lost/stolen till | Shop owner: Settings → Devices → Revoke (admin device); or operator: console → tenant → Devices → Revoke |
| Staff leaves | Settings → Cashiers → deactivate (keeps history) |
| Forgotten owner PIN | another owner of the shop, else the operator ([05 §3](05-auth-and-roles.md#3-shop-admin-on-admin-devices)) |
| Owner lost every admin device | operator issues a new owner pairing code for the tenant |
| Change or add an operator email (v1: only `adnan@yaqoob.org`) | Cloudflare Access application "Bikri admin" policy + `OWNER_EMAILS` secret — both, then record it in `docs/decisions.md` |
| Rotate Cloudflare API token | create new token → update GitHub secret → revoke old |

## 6. Data retention and privacy

Customer data (names, phones) of every shop stays in the operator's Cloudflare account, the operator's encrypted backups and each shop's own exports. Shops never see each other's data. Only the sync change stream (`change_log`, 30 days), op receipts (`applied_ops`, 90 days) and usage counters (`tenant_usage`, 90 days) are pruned; business records are kept for the life of the shop and deleted with the shop (§3.5). No analytics, no third-party scripts, no telemetry. Deleting a customer is a soft delete (history is needed for accounts); a "Erase personal data" action (v2) replaces name/phone/address with `Deleted customer` while keeping amounts. What shops are told is in §6.1.

### 6.1 Terms and privacy notes for shop owners

Plain-language notes shown to every shop owner: linked from the owner pairing step of the [enrol screen](screens/02-enrol.md) and from Settings → About, and repeated in `docs/owner-guide.md` (T-065). English, Urdu and Roman Urdu. Whether owners must tick to accept them, and a legal review, are open ([13 §9](13-multi-tenancy.md#9-open-questions-owner-decision-needed)).

1. **Who runs Bikri.** Algovyn (the operator, Adnan) runs this Bikri deployment on Cloudflare for several shops. Your shop's data is kept apart from other shops; no other shop can see it.
2. **What Algovyn can see.** Because Algovyn runs the database and holds the backup key, Algovyn can technically read your shop's data. Algovyn looks at it only to run the service, to restore it, or when you ask for help.
3. **What you will always see.** Every time Algovyn exports, imports or restores your shop's data, changes your shop's status (for example to read-only) or uses support access, a row appears in Settings → Activity with the operator and details; status changes and support access show the reason. Support access is time-limited (at most 24 hours at a time), shows a banner on all your tills while it lasts, and you can end it at any time.
4. **Read-only.** If your shop is made read-only (for example for an unpaid bill), you can still sign in, see all your reports and history and export your data; you can't make new sales or changes until it is active again. Sales your tills made before they learned about it are kept.
5. **Your copy.** You can download a full export of your shop at any time: from a till (Settings → Backup) or from the server (once a day).
6. **Backups and deletion.** Algovyn makes an encrypted backup of all shops every night. If your shop is deleted, its data is removed from the live database, but copies stay in the encrypted backups until they expire: up to **30 days** in daily backups, up to **12 months** in monthly backups and up to **90 days** in the off-site copies. After that it is gone. Ask for an export before deletion if you want to keep it.
7. **Email.** Your email address is used only to send you sign-in codes. Bikri has no analytics, ads or tracking.
8. **Receipts.** Your receipts show your shop's name and logo, and a small "Powered by AlgoVyn" line at the bottom.

## 7. Go-live checklist

Before the first real sale on `https://algovyn.com/bikri/` (and before each release, T-065):

1. **Website gate passes:** `node tools/check-website.mjs` reports no third-party scripts and no service worker anywhere on `algovyn.com` ([01 §5.5](01-architecture.md#55-release-gate-a-clean-algovyncom-decision-d-049)). As of 27 Oct 2026 it fails until the website's `cdn.tailwindcss.com` script is replaced by the built `tailwind.css`.
2. `website-guard.yml` is enabled (nightly) and its last run is green.
3. `curl -sI https://algovyn.com/bikri/` shows the CSP and HSTS headers; `/bikri/api/health` returns `ok: true`.
4. Cloudflare Access protects `/bikri/admin*` and `/bikri/api/admin*` for `adnan@yaqoob.org` only (try from a private window: OTP login required).
5. The nightly backup ran and restore drills H11 (whole DB) and H14 (one tenant) passed; the cron trigger shows in the Worker's Triggers tab.
6. Hardware checklist H1–H14 recorded ([10 §6](10-testing.md#6-manual-hardware-checklist-before-each-release)).
7. The cross-tenant isolation suite ([10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory)) passed on the release commit, and a manual two-shop check on production: a till of shop B cannot see shop A's products, sales, customers or photos.
