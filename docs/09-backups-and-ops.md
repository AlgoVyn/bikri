# 09 — Backups and operations

Goal (REQ-B13): the owner can always get **all** data out, restore it onto a fresh deploy, and no single provider failure loses more than one day of synced data. Unsynced data lives on the tills until pushed.

## 1. Layers of protection

| Layer | What | RPO | Where |
|---|---|---|---|
| 1. Tills (IndexedDB, persisted storage) | Every record, immediately | 0 for that device | each browser |
| 2. D1 live | Synced data | ≤ 60 s while online | Cloudflare |
| 3. D1 Time Travel | Point-in-time restore of the DB | any minute, last 7 days (free plan) | Cloudflare |
| 4. Nightly export to R2 | `wrangler d1 export` SQL, gzipped | 24 h | R2 `bikri-backups/d1/` (separate bucket, never reachable by the till file API) |
| 5. Off-Cloudflare copy | same file encrypted with `age` | 24 h | GitHub Actions artifact (90 days) + optional owner Google Drive |
| 6. Owner manual export | JSON + CSV zip from Settings → Backup | on demand | owner's PC/phone |
| 7. R2 files (logo, photos) | weekly `rclone`-style listing + copy of new objects into the encrypted archive | 7 days | as layer 5 |

## 2. Nightly backup workflow (`.github/workflows/backup.yml`)

Schedule `cron: "30 21 * * *"` (UTC) = **02:30 Asia/Karachi** daily; also `workflow_dispatch`.

Steps:
1. Checkout, setup Node 24, `pnpm i --filter tools`.
2. `wrangler d1 export bikri --remote --output=bikri-YYYY-MM-DD.sql` (date in Asia/Karachi).
3. Sanity check: file > 1 KB and contains `CREATE TABLE sales`; row counts via `wrangler d1 execute bikri --remote --command "SELECT count(*) FROM sales"` etc. written to `manifest.json` `{ date, tables: { sales: 20311, … }, sha256 }`.
4. `gzip -9` → upload to R2 bucket `bikri-backups`: `d1/YYYY-MM-DD.sql.gz` + `d1/YYYY-MM-DD.manifest.json` (`wrangler r2 object put bikri-backups/d1/… --remote`).
5. Encrypt `age -r $BACKUP_AGE_RECIPIENT` → upload as workflow artifact `backup-YYYY-MM-DD` (retention 90 days).
6. Retention in R2: keep 30 daily, 12 monthly (1st of month); delete older (script lists and deletes).
7. On failure: GitHub sends the default failure email to the repo owner; the Admin Overview shows "Last backup: 2 days ago" in red when the newest manifest is > 36 h old.

Free-tier impact: one export per night is a few hundred thousand rows read (≪ 5 M/day) and ~3 Class A R2 ops.

A running `wrangler d1 export` **blocks all other queries on the database** (Cloudflare D1 import/export docs), so it runs at 02:30 PKT when the shop is closed; a till that pushes during the export gets an error and simply retries with backoff. D1 cannot export databases that contain virtual tables (e.g. FTS5), so **never add virtual tables** to the schema (product search is done on the till in Dexie).

The repo is public, so GitHub Actions artifacts can be downloaded by other GitHub users: that is why the off-Cloudflare copy is always `age`-encrypted before upload; never upload the plain `.sql.gz` as an artifact.

The `age` private key is generated once by the owner (`age-keygen`), kept offline (printed + password manager); only the public recipient is a GitHub secret.

## 3. Restore procedures

### 3.1 Undo a mistake in the last 7 days (Time Travel)

1. Find the time: Admin → Activity or audit log.
2. `wrangler d1 time-travel info bikri --timestamp=2026-10-26T10:00:00+05:00` → bookmark.
3. **Stop tills from pushing**: set Worker var `MAINTENANCE=1` (`/api/sync/*` returns `503 MAINTENANCE`; tills keep selling offline and queue ops).
4. `wrangler d1 time-travel restore bikri --bookmark=<id>`.
5. Set a new restore epoch and the restore point (never increment, a restored DB carries its own old value):
   ```sql
   UPDATE meta SET value = CAST(<now_epoch_ms> AS TEXT) WHERE key = 'restore_epoch';
   UPDATE meta SET value = CAST(<restore_point_epoch_ms> AS TEXT) WHERE key = 'restore_point_at';
   ```
   Tills see the new epoch on next pull and run **restore recovery** ([03 §4.2](03-sync.md#42-pull--get-apisyncpullsinceseqlimit500)): re-send their own ledger rows created after the restore point, full re-pull, then push the outbox; invoice counters never go backwards.
6. Unset `MAINTENANCE`.

Note: rows created after the restore point are re-sent by the tills that created them; only master-data edits made after the restore point, and rows from tills that no longer exist or whose browser data was cleared, are lost. Warn the owner before step 4 with the count of `change_log` rows after the bookmark.

### 3.2 Restore a nightly backup to a new database

1. `wrangler d1 create bikri-restore`; `gunzip`; `wrangler d1 execute bikri-restore --remote --file=bikri-YYYY-MM-DD.sql`.
2. Verify counts against `manifest.json`.
3. Point the `DB` binding to the new database ID in `wrangler.jsonc`, deploy, then set `restore_epoch` / `restore_point_at` exactly as in §3.1 step 5 (restore point = the backup's `manifest.json` `date` at 02:30 PKT).
4. **Restore drill:** before v1.0.0 and then every 3 months, restore last night's backup into `bikri-restore` and compare `manifest.json` counts (checklist item in [10 §6](10-testing.md#6-manual-hardware-checklist-before-each-release)); delete the drill DB afterwards.

### 3.3 Restore from the owner's JSON export (new deploy / leaving Cloudflare)

Settings → Backup → `Restore from export` is only enabled when the server reports an empty shop (`shop_setup_completed = false`, 0 sales). The till uploads in batches via normal sync push (ops with original IDs), so the same validation applies. Format: `bikri-export-YYYYMMDD-HHmm.zip` containing `manifest.json` (`{ format: "bikri-export", version: 1, exported_at, app_version, tables: {name: count} }`), `json/<table>.json` (array of rows exactly as in 02, money in paisa) and `csv/<table>.csv` (human-friendly: amounts in rupees with 2 decimals, dates ISO in Asia/Karachi). The JSON is the restore source; CSV is for Excel.

## 4. Monitoring and limits

- `GET /api/health` (no auth) returns the shape in [04 §3.1](04-api.md#31-get-apihealth) (`db` is the result of `SELECT 1`); owner can add a free uptime monitor on `https://algovyn.com/bikri/api/health`.
- Admin Overview shows: D1 size vs 500 MB, rows written today (from `meta.writes_today` counter incremented by push) vs 100k, pending ops and oldest unsynced op per device (`devices.pending_ops` / `oldest_pending_at`, from the `X-Bikri-Pending` header, [03 §6](03-sync.md#6-scheduling)), last backup age.
- Warnings at 70% of any free-tier limit; at 90% the push handler still accepts but Admin shows red with "Consider Workers Paid ($5/month)".
- Logs: `console.log` JSON lines `{ level, route, device_id, op_count, ms, error_code }`; view with `wrangler tail` or Workers Logs (observability enabled in `wrangler.jsonc`, sampling 10%). Never log tokens, PIN hashes, phone numbers or customer names.

## 5. Routine operations

| Task | How |
|---|---|
| Deploy | merge to `main` → CI runs tests → website check ([01 §5.5](01-architecture.md#55-release-gate-a-clean-algovyncom-decision-d-049)) → `wrangler d1 migrations apply bikri --remote` → `wrangler deploy` |
| Sync log retention | automatic: nightly cron deletes `change_log` rows older than 30 days and `applied_ops` older than 90 days ([03 §4.4](03-sync.md#44-retention-pruning-and-stale-tills)); Admin Overview shows `change_log_floor` and the last prune time |
| Rollback app | `wrangler rollback` (previous version); migrations are forward-only and additive (never drop/rename columns in v1) |
| New migration | `drizzle-kit generate` → review SQL → commit `packages/db/migrations/000N_*.sql`; bump `SCHEMA_VERSION` and the Dexie version; must be backward compatible with the previous till version for 14 days ([01 §7.2](01-architecture.md#72-cicd)) |
| Lost/stolen till | Admin → Devices → Revoke |
| Staff leaves | Settings → Cashiers → deactivate (keeps history) |
| Forgotten owner PIN | Admin → Owner PIN reset |
| Change or add an admin email (v1: only `adnan@yaqoob.org`) | Cloudflare Access application "Bikri admin" policy + `OWNER_EMAILS` secret — both, then record it in `docs/decisions.md` |
| Rotate Cloudflare API token | create new token → update GitHub secret → revoke old |

## 6. Data retention and privacy

Customer data (names, phones) stays in the owner's Cloudflare account and the owner's exports. Only the sync change stream (`change_log`, 30 days) and op receipts (`applied_ops`, 90 days) are pruned; business records are kept for the life of the shop. No analytics, no third-party scripts, no telemetry. Deleting a customer is a soft delete (history is needed for accounts); a "Erase personal data" action (v2) replaces name/phone/address with `Deleted customer` while keeping amounts.

## 7. Go-live checklist

Before the first real sale on `https://algovyn.com/bikri/` (and before each release, T-065):

1. **Website gate passes:** `node tools/check-website.mjs` reports no third-party scripts and no service worker anywhere on `algovyn.com` ([01 §5.5](01-architecture.md#55-release-gate-a-clean-algovyncom-decision-d-049)). As of 27 Oct 2026 it fails until the website's `cdn.tailwindcss.com` script is replaced by the built `tailwind.css`.
2. `website-guard.yml` is enabled (nightly) and its last run is green.
3. `curl -sI https://algovyn.com/bikri/` shows the CSP and HSTS headers; `/bikri/api/health` returns `ok: true`.
4. Cloudflare Access protects `/bikri/admin*` and `/bikri/api/admin*` for `adnan@yaqoob.org` only (try from a private window: OTP login required).
5. The nightly backup ran and restore drill H11 passed; the cron trigger shows in the Worker's Triggers tab.
6. Hardware checklist H1–H13 recorded ([10 §6](10-testing.md#6-manual-hardware-checklist-before-each-release)).
