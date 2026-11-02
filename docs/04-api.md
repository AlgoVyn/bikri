# 04 — API

Base URL: `https://algovyn.com/bikri/api` (path-based, see [01 §1.1](01-architecture.md#11-url-layout-and-the-path-convention-used-in-these-docs)). Paths below and elsewhere in the docs (`/api/sync/push` etc.) are relative to the `/bikri` base path; in code use `API_BASE` from `packages/core/src/paths.ts`. Same origin as the app, so no CORS. All bodies are JSON (`Content-Type: application/json; charset=utf-8`) except file upload/download.

## 1. Endpoint list

Every device-authenticated endpoint acts on **the caller's tenant only** (from the token, [13 §5](13-multi-tenancy.md#5-tenant-scoping-rules-for-implementers)); no request body or query names a tenant. Operator endpoints name the tenant in the path.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness and versions |
| POST | `/devices/enrol` | none (rate-limited) | Exchange an enrolment code for a device token (the code decides the tenant) |
| GET | `/me` | device | Tenant, device, branch and setup status |
| POST | `/sync/push` | device | Push outbox ops ([03 §4.1](03-sync.md#41-push--post-apisyncpush)) |
| GET | `/sync/pull` | device | Pull changes since a cursor ([03 §4.2](03-sync.md#42-pull--get-apisyncpullsinceseqlimit500)) |
| GET | `/sync/snapshot` | device | Full copy of the tenant's synced tables, paged per table ([03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot)) |
| PUT | `/files/:kind/:id/:sha256` | device + `X-Bikri-Staff` with `catalog.edit` (photo) or `settings.shop` (logo) | Upload a product image or logo |
| GET | `/files/*key` | device | Download a file from R2 |
| GET/POST/DELETE | `/shop/enrolment-codes` | admin device + owner | List, create, cancel enrolment codes for this shop ([05 §3](05-auth-and-roles.md#3-shop-admin-on-admin-devices)) |
| GET | `/shop/devices` | admin device + owner | List this shop's devices |
| PATCH | `/shop/devices/:id` | admin device + owner | Rename / move branch / set `is_admin` |
| POST | `/shop/devices/:id/revoke` | admin device + owner | Revoke a device |
| POST | `/shop/import-ops` | admin device + owner | Import the unsynced-ops file of a revoked device of this shop ([03 §8](03-sync.md#8-device-revocation-and-data-loss-window)) |
| POST | `/shop/conflicts/:id/acknowledge` | admin device + owner | Mark a `sync_conflicts` row acknowledged |
| POST | `/shop/owner-signin/start`, `/shop/owner-signin/verify` | admin device + owner PIN (no session yet) | Email a one-time code to the shop's owner email; exchange it for an owner session ([05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082)) |
| GET | `/shop/export` | admin device + owner | Owner's server export of this shop, paged like the snapshot ([13 §7.3](13-multi-tenancy.md#73-per-tenant-export-and-restore)) |
| POST | `/shop/support-access/end` | admin device + owner PIN (no session needed) | End the operator's support access now ([13 §7.5](13-multi-tenancy.md#75-operator-support-access-d-084)) |
| GET | `/admin/session` | Access | Who is signed in to the operator console |
| GET | `/admin/usage` | Access | Account-wide usage today: Σ `tenant_usage`, per tenant, vs free-tier limits |
| GET/POST | `/admin/tenants` | Access | List tenants; create a tenant (+ default branch, expense categories, owner pairing code) |
| GET/PATCH | `/admin/tenants/:id` | Access | Tenant detail; edit display name, budget, poll interval, note |
| POST | `/admin/tenants/:id/read-only`, `/suspend`, `/reactivate`, `/delete` | Access | Lifecycle with a required reason ([13 §7](13-multi-tenancy.md#7-tenant-lifecycle)) |
| POST | `/admin/tenants/:id/support-access`, `/admin/tenants/:id/support-access/end` | Access | Start (reason, hours → support enrolment code) or end operator support access ([13 §7.5](13-multi-tenancy.md#75-operator-support-access-d-084)) |
| POST | `/admin/tenants/:id/enrolment-codes` | Access | Issue a code (e.g. a new owner pairing code) |
| GET | `/admin/tenants/:id/devices` | Access | List the tenant's devices |
| POST | `/admin/tenants/:id/devices/:device_id/revoke` | Access | Revoke a device |
| GET | `/admin/tenants/:id/export` | Access | Paged export of the tenant's tables (same paging as the snapshot) |
| POST | `/admin/tenants/:id/maintenance` | Access | `{ on: boolean }` set or clear `status = 'maintenance'` for a restore |
| POST | `/admin/tenants/:id/purge` | Access | Delete the tenant's rows in chunks (only in maintenance) |
| POST | `/admin/tenants/:id/import` | Access | Import export pages into an emptied tenant (only in maintenance) |
| POST | `/admin/tenants/:id/restore-epoch` | Access | `{ restore_point_at }` set a new `restore_epoch` for the tenant |
| POST | `/admin/tenants/:id/import-ops` | Access | Import a revoked device's unsynced ops |
| POST | `/admin/tenants/:id/reset-owner-pin` | Access | Set a new owner PIN when no other owner can |
| GET | `/admin/backups` | Access | List backup objects in R2 |
| GET | `/admin/backups/*key` | Access | Download a backup |
| GET | `/admin/usage` | Access | Account overview: tenants by status, gross D1 usage, last backup, shops over 80 % of their budget, and open sync conflicts grouped by tenant (D-105, D-136) |
| GET | `/admin/slug-available?slug=` | Access | Whether a slug is free (D-105) |
| GET | `/admin/tenants/:id/devices` | Access | A shop's devices (D-105) |
| POST | `/admin/tenants/:id/devices/:deviceId/revoke` | Access | Revoke one of a shop's devices (D-105) |
| GET | `/admin/tenants/:id/owners` | Access | A shop's owner staff, for PIN reset (D-105) |
| GET | `/admin/backups/download?key=` | Access | Download a backup by query key (D-105) |

## 2. Conventions

- **Auth header (device):** `Authorization: Bearer <device_token>` where the token is 43 base64url chars (32 random bytes).
- **Auth (shop admin):** device token of an admin device plus `X-Bikri-Staff: <owner staff id>` ([05 §3](05-auth-and-roles.md#3-shop-admin-on-admin-devices)) plus `X-Bikri-Owner-Session: <token>` from the owner email sign-in ([05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082)), except where the table above says otherwise.
- **Auth (operator):** Cloudflare Access adds `Cf-Access-Jwt-Assertion`; the Worker verifies it ([05 §3.1](05-auth-and-roles.md#31-platform-operator-via-cloudflare-access)).
- **Version headers:** the till sends `X-Bikri-App: 1.0.0` and `X-Bikri-Schema: 2` on every request.
- **Times** are epoch ms. **Money** is paisa integers.
- **Error shape** (all non-2xx):

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "ops must contain at most 200 ops", "details": { "path": ["ops"] } } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body/query fails request-envelope validation |
| 400 | `BAD_ENROLMENT_CODE` | Code unknown, used or expired |
| 400 | `BAD_SIGNIN_CODE` | Owner sign-in code wrong, expired, used or out of tries (`details.tries_left`) |
| 401 | `UNAUTHENTICATED` | Missing/unknown token or Access JWT |
| 401 | `DEVICE_REVOKED` | Token belongs to a revoked device, or a support device past its `expires_at` |
| 401 | `OWNER_SIGNIN_REQUIRED` | `/shop/*` call without a valid owner session; the till runs the email sign-in |
| 403 | `FORBIDDEN` | Access email not in `OWNER_EMAILS`, not an admin device / not an owner on `/shop/*`, a push or upload from a support device, or permission failure |
| 403 | `TENANT_SUSPENDED` | The caller's tenant is suspended or being deleted; the till keeps selling offline |
| 403 | `TENANT_READ_ONLY` | The caller's tenant is `read_only` and the request would create or change business data (push ops created after the device learned it, file upload, ops import, conflict acknowledge); `details.since` = read-only start. The till keeps the ops pending and shows the read-only banner ([13 §7.2](13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)) |
| 404 | `NOT_FOUND` | File, device or tenant not found **in the caller's tenant** (the same answer whether or not the id exists in another tenant) |
| 409 | `SCHEMA_OUTDATED` | Client schema version < `MIN_CLIENT_SCHEMA` |
| 409 | `SLUG_TAKEN` / `NOT_IN_MAINTENANCE` / `LAST_ADMIN_DEVICE` / `BAD_STATUS_CHANGE` | Operator and shop-admin endpoints (§3.7, §3.8) |
| 410 | `SNAPSHOT_REQUIRED` | Pull `since` is below the tenant's `change_log_floor` (changes pruned after 30 days); `details.change_log_floor` |
| 413 | `PAYLOAD_TOO_LARGE` | Push body > 1 MB, image > 2 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Upload not webp/png/jpeg |
| 429 | `RATE_LIMITED` | Too many requests (see §6); owner sign-in codes and server exports also use it, with `Retry-After` |
| 500 | `INTERNAL` | Unexpected; includes `details.request_id` |
| 503 | `MAINTENANCE` | Worker var `MAINTENANCE=1` (whole deployment) or the caller's tenant has `status = 'maintenance'` (restore of that shop); client keeps ops, retries after `Retry-After: 300` |
| 503 | `TENANT_QUOTA` | The caller's tenant reached its `daily_write_budget` for the UTC day ([13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)); `Retry-After` = seconds to 00:00 UTC; client keeps ops |
| 503 | `D1_LIMIT` | D1 daily free limit of the account reached (all tenants); client keeps ops and retries after `Retry-After` |
| 503 | `EMAIL_UNAVAILABLE` | The owner sign-in email could not be sent (owner email missing or not a verified destination address, or Cloudflare error) |

Per-op errors inside a push response use `error_code`: `CONSTRAINT_FAILED`, `UNIQUE_VIOLATION`, `FOREIGN_KEY`, `FORBIDDEN`, `IMMUTABLE_TABLE` (update/delete attempted on a ledger table), `UNKNOWN_TABLE`, `SETUP_ALREADY_DONE` (a `shop` insert when `setup_completed_at` is already set).

## 3. Endpoints

### 3.1 `GET /api/health`
```json
200 { "ok": true, "app_version": "1.0.0", "schema_version": 2, "min_client_schema": 1, "db": "ok", "time": 1793050000000 }
```

### 3.2 `POST /api/devices/enrol`
Request:
```json
{ "code": "K7Q2-M9XD", "user_agent": "Mozilla/5.0 ...", "app_version": "1.0.0", "device_name": "Counter 2" }
```
`device_name` is optional (≤ 40); without it the device gets the name on the code (D-107). The response also carries `tenant_status`, `support` and `poll_after_ms` (D-105).

Response `201`:
```json
{
  "tenant": { "id": "01JBZT...", "display_name": "Algovyn Mobiles" },
  "device": { "id": "01JC0Z8K3V7R1M2Q4S6T8V0X2Y", "name": "Counter 1", "branch_id": "01JC0Y...", "device_code": "A", "is_admin": true, "last_invoice_seq": 0 },
  "token": "q3J4m...43chars",
  "shop_setup_completed": false
}
```
Errors: `400 BAD_ENROLMENT_CODE`, `403 TENANT_SUSPENDED`, `429 RATE_LIMITED`. The code is single-use and valid 15 minutes (owner pairing codes 72 hours). The new device belongs to the code's tenant and branch; `is_admin` = the code's `grants_admin`. A `support` code creates a `kind = 'support'` device named "Algovyn support" with `expires_at = tenants.support_until` (the response's `device.kind` is `support`). Enrolment works for `active` and `read_only` shops. The plain token is returned **once** and stored only as a SHA-256 hash.

### 3.3 `GET /api/me`
```json
200 {
  "tenant": { "id": "01JBZT...", "display_name": "Algovyn Mobiles", "status": "active" },
  "tenant_status": { "status": "active", "since": null },
  "support": null,
  "device": { "id": "01JC0Z...", "name": "Counter 1", "branch_id": "01JC0Y...", "device_code": "A", "is_admin": false, "kind": "till", "revoked": false },
  "shop_setup_completed": true,
  "poll_after_ms": 60000,
  "server_time": 1793050000000,
  "latest_seq": 48213
}
```

`tenant_status.status` is one of `active`, `read_only` (`since` = read-only start, epoch ms); the other statuses never reach a till as a 200 (they answer `403`/`503`). `support` is `{ "until": 1793057200000, "reason": "Printer not syncing" }` while operator support access is active, else `null` ([13 §7.5](13-multi-tenancy.md#75-operator-support-access-d-084)). The first response that carries `read_only` to a device sets its `read_only_seen_at` ([13 §7.2](13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)).

### 3.4 `POST /api/sync/push` and `GET /api/sync/pull`
Specified in [03-sync §4](03-sync.md#4-protocol). Limits: ≤ 200 ops, ≤ 1 MB body; `limit` for pull 1–1000 (default 500). Push and pull responses also carry `tenant_status` and `support` (same shapes as `/api/me`).

`GET /api/sync/snapshot` and `GET /api/sync/snapshot?tbl=&after=&limit=` are specified in [03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot). `tbl` must be one of the snapshot tables (else `400 VALIDATION_FAILED`); `after` is an id (empty = from the start); `limit` 1–1000 (default 500).

### 3.5 `PUT /api/files/:kind/:id/:sha256`
- `kind` ∈ `product_image`, `logo`. `id` = product ID (or `shop` for logo). `sha256` = hex digest of the body (client computes).
- Body: raw bytes, `Content-Type: image/webp | image/png | image/jpeg`, ≤ 2 MB (client resizes first: product images 512×512 max WebP q=0.8; logo PNG ≤ 576 px wide). A logo must be `image/png`; other types → `415 UNSUPPORTED_MEDIA_TYPE`.
- Server verifies the digest and the staff permission (`catalog.edit` for a product photo, `settings.shop` for the logo; no header → `403 FORBIDDEN`), writes R2 key `t/<tenant_id>/products/<id>/<sha256>.webp` (or `.jpg` / `.png` for those upload types) or `t/<tenant_id>/shop/logo-<sha256>.png` (the tenant prefix is added by the server from the token and never shown to the till), returns the **relative** key:
```json
201 { "key": "products/01J9.../9f2c...e1.webp", "size": 24311 }
```
The till then upserts `products.image_key` / `shop.logo_key` through the normal sync path. Uploading the same digest twice is a no-op `200`.

### 3.6 `GET /api/files/*key`
`key` is the relative key; the Worker reads `t/<caller's tenant_id>/<key>`, so a till can only ever read its own shop's files, whatever key it asks for. Streams the R2 object from `FILES` with `Cache-Control: private, max-age=31536000, immutable` and `ETag`. **Only keys matching `^products/[0-9A-HJKMNP-TV-Z]{26}/[0-9a-f]{64}\.(webp|jpg|png)$` or `^shop/logo-[0-9a-f]{64}\.png$` are served**; anything else → `404 NOT_FOUND`. Backups live in the separate `bikri-backups` bucket and are reachable only through the operator's `/api/admin/backups/*`. Keys are content-addressed, so they never change.

### 3.7 Operator endpoints (Cloudflare Access)

`GET /api/admin/session` → `200 { "email": "operator@example.com" }`

`POST /api/admin/tenants`
```json
{ "slug": "hall-road-mobiles", "display_name": "Hall Road Mobiles", "owner_email": "owner@example.com", "daily_write_budget": 18000, "note": "" }
→ 201 { "tenant": { "id": "01JBZT...", "slug": "hall-road-mobiles", "status": "active", ... },
        "owner_code": { "code": "K7Q2-M9XD", "expires_at": 1793309200000, "link": "https://algovyn.com/bikri/enrol?code=K7Q2M9XD" } }
```
Creates the tenant, its default branch (`Main` / `INV`), its expense categories from the templates, their `change_log` rows and an owner pairing code (`grants_admin = 1`, 72 h), in one batch ([02 §2.1](02-data-model.md#21-seed-data-migration-0002_seedsql)). `409 SLUG_TAKEN` if the slug exists (also for deleted tenants).

`GET /api/admin/tenants` → `200 { "tenants": [ { "id", "slug", "display_name", "status", "devices": 3, "last_seen_at", "today": { "rows_written", "rows_read", "pushes" }, "daily_write_budget", "setup_completed": true } ], "account_today": { "rows_written", "rows_read" } }`

`owner_email` is optional at creation (the operator's own shop can add it later) but owner email sign-in, and therefore the shop-admin API, works only once it is set and verified in Cloudflare ([05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082)).

`PATCH /api/admin/tenants/:id` `{ "display_name"?, "daily_write_budget"?, "poll_after_ms"?, "note"?, "owner_email"? }` → `200 { "tenant": {...} }`; an `owner_email` change writes `owner_email_change` in the tenant's audit log (`after_json` holds the masked address). `display_name` is the console label and the pre-fill for the setup wizard; the shop's own `shop.name` (receipts) is edited by the shop owner.

`POST /api/admin/tenants/:id/read-only` / `suspend` / `reactivate` `{ "reason": "Unpaid since October" }` (1–200 chars, required) → `200 { "tenant": {...} }`. Each writes `tenants.status`, `status_reason`, `status_changed_at`, `status_changed_by` and a `tenant_status_change` audit row in the tenant in one batch; `reactivate` from `read_only` also clears `devices.read_only_seen_at` for the tenant ([13 §7.2](13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)). Allowed transitions: `active` ↔ `read_only`, `active`/`read_only` → `suspended`, `suspended` → `active`/`read_only` (via `reactivate { to }`, default `active`); others → `409 BAD_STATUS_CHANGE`. `POST /api/admin/tenants/:id/delete` `{ "confirm_slug": "hall-road-mobiles", "reason": "…" }` → `202` (status `deleting`, devices revoked; rows removed by the nightly cron, [03 §4.4](03-sync.md#44-retention-pruning-and-stale-tills)).

`POST /api/admin/tenants/:id/support-access` `{ "reason": "Printer not syncing", "hours": 2 }` (`hours` ∈ 1, 2, 4, 8, 24) → `201 { "code", "expires_at", "link", "support_until" }`: sets `support_until` / `support_reason`, extends already-enrolled support devices’ `expires_at`, creates a single-use `kind = 'support'` enrolment code (15 min) and writes `support_access_start`. `POST /api/admin/tenants/:id/support-access/end` → `200`: `support_until = now`, revokes the tenant's support devices, writes `support_access_end` (`ended_by: 'operator'`). `409 BAD_STATUS_CHANGE` when the tenant is not `active` or `read_only`.

`POST /api/admin/tenants/:id/enrolment-codes` `{ "device_name", "branch_id"?, "grants_admin": true }` → `201 { "code", "expires_at", "link" }` (72 h when `grants_admin`, else 15 min).

`POST /api/admin/tenants/:id/files/gc` `{ "dry_run"?: true }` → `200 { "examined", "unreferenced", "deleted", "bytes" }`. Lists `t/<tenant>/` and deletes objects not referenced by `products.image_key` or `shop.logo_key` and at least 24 h old; `dry_run` defaults to `true`. Writes `operator_file_gc` in the tenant.

`GET /api/admin/tenants/:id/export?tbl=&after=&limit=` → same shapes as the snapshot ([03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot)), for that tenant; the first call (no `tbl`) captures the server cutoff as `exported_at` and also writes an `audit_log` row `operator_export` in the tenant. Pages use `before=<exported_at>`. `devices.token_hash` and `devices.enrolled_by` are never exported.

Restore of one tenant ([09 §3.4](09-backups-and-ops.md#34-restore-one-tenant)): `POST …/maintenance { on: true }` → `POST …/purge` (repeat until `{ "remaining": 0 }`; each call deletes ≤ 5,000 rows child tables first) → `POST …/import { tbl, rows: [...] }` (≤ 500 rows per call, rows checked by `checkOp` and the D1 constraints, written with `INSERT … (tenant_id, …)` and `change_log` rows) → `POST …/restore-epoch { restore_point_at }` → `POST …/maintenance { on: false }`. Purge and import return `409 NOT_IN_MAINTENANCE` otherwise.

`POST /api/admin/tenants/:id/import-ops` `{ "device_id": "01JC…", "ops": [ … ] }` (≤ 200 ops per call) → same response shape as push. `404 NOT_FOUND` if the device is not in that tenant, `403 FORBIDDEN` if it is not revoked. For a `read_only` tenant only ops created before the read-only start (`status_changed_at`) are imported; the rest are omitted from `results`.

`POST /api/admin/tenants/:id/reset-owner-pin` `{ "staff_id": "01JB...", "pin_hash": "<base64>", "pin_salt": "<base64>", "pin_iterations": 150000, "pin_length": 4 }` → the **console page in the browser** computes the PBKDF2 hash with WebCrypto (the Worker never hashes PINs, to stay inside the 10 ms CPU limit); the Worker updates that tenant's active owner row with `rev+1` and the new `pin_length`, appends `change_log` and an `audit_log` row (`pin_reset`) → `200 { "ok": true }`. Inactive or non-owner staff ids → `404 NOT_FOUND`.

`GET /api/admin/backups?prefix=d1/` (bucket `bikri-backups`; downloads are sent with `Cache-Control: no-store` and `Content-Disposition: attachment`) → `200 { "objects": [ { "key": "d1/2026-10-27.sql.gz", "size": 4810233, "uploaded": 1793050000000 } ] }`. Backups are whole-database (all tenants), [09 §2](09-backups-and-ops.md#2-nightly-backup-workflow-githubworkflowsbackupyml).

### 3.8 Shop-admin endpoints (admin device)

Device token of an admin device (`is_admin = 1`) **and** `X-Bikri-Staff` = an active `owner` of the same tenant ([05 §3](05-auth-and-roles.md#3-shop-admin-on-admin-devices)) **and** `X-Bikri-Owner-Session` ([05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082)); otherwise `403 FORBIDDEN` / `401 OWNER_SIGNIN_REQUIRED`. Support devices are never admin devices. Online only. Every call that changes something writes an `audit_log` row in the tenant.

`POST /api/shop/owner-signin/start` (no body; no session needed) → `200 { "code_id": "01JC…", "expires_at": 1793050600000, "email_hint": "a***@gmail.com" }`; `429 RATE_LIMITED` (cooldown, hourly or daily cap, paused after 3 dead codes), `503 EMAIL_UNAVAILABLE`. `POST /api/shop/owner-signin/verify` `{ "code_id", "code": "482913" }` → `200 { "session": "<token>", "expires_at": 1793093200000 }`; wrong code → `400 BAD_SIGNIN_CODE` with `details.tries_left`; expired, used or dead → `400 BAD_SIGNIN_CODE` with `tries_left: 0`. The same error body whether or not `code_id` exists (in this tenant or another).

`GET /api/shop/export` (no query) → starts an export: `200 { "export_id": "<signed token, 2 h>", "snapshot_seq", "tables": [ { "tbl", "rows" } ] }`, writes `owner_export`, sets `tenants.last_owner_export_at`; `429 RATE_LIMITED` with `Retry-After` if a server export was started in the last 24 hours. `GET /api/shop/export?export_id=&tbl=&after=&limit=` → the snapshot page shape ([03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot)) for this tenant (`limit` 1–500); `export_id` must belong to this tenant and device and not be expired (else `400 VALIDATION_FAILED`). Allowed for `active` and `read_only` shops.

`POST /api/shop/support-access/end` (admin device + owner PIN header; no session needed) → `200` (or `200` with `{ "ended": false }` when no support access is active); writes `support_access_end` (`ended_by: 'owner'`).

`POST /api/shop/enrolment-codes`
```json
{ "device_name": "Counter 2", "branch_id": "01JC0Y...", "is_admin": false }
→ 201 { "code": "K7Q2-M9XD", "expires_at": 1793050900000, "link": "https://algovyn.com/bikri/enrol?code=K7Q2M9XD" }
```
Code alphabet: `23456789ABCDEFGHJKMNPQRSTVWXYZ` (30 symbols, no `0 O 1 I L U`, matching [screens/02](screens/02-enrol.md)); 8 chars (30⁸ ≈ 6.6 × 10¹¹) shown as `XXXX-XXXX`. Codes are generated with `crypto.getRandomValues` and rejection sampling; only the SHA-256 is stored, with the tenant.

`GET /api/shop/enrolment-codes` → `{ codes: [ { code_hint: 'K7Q2-…', device_name, is_admin, expires_at } ] }` (unused, unexpired, this tenant only); `DELETE /api/shop/enrolment-codes/:code` → `204`. The page keeps the plain code in memory until it expires.

`GET /api/shop/devices` → `200 { "devices": [ { "id", "name", "branch_id", "device_code", "is_admin", "enrolled_at", "last_seen_at", "app_version", "pending_ops", "oldest_pending_at", "revoked_at" } ] }`

`PATCH /api/shop/devices/:id` `{ "name"?: string, "branch_id"?: string, "is_admin"?: boolean }` → `200 { "device": {...} }`. Moving a device to another branch assigns it a **new** `device_code` in the target branch (codes are never reused), so invoice numbers stay unique; the till picks up the new code on its next `/api/me` and continues its own `invoice_seq`. Removing admin from the last admin device → `409 LAST_ADMIN_DEVICE`.

`POST /api/shop/devices/:id/revoke` → `200 { "revoked_at": 1793050000000 }` (`409 LAST_ADMIN_DEVICE` for the last admin device; the operator can still revoke it).

`POST /api/shop/import-ops` `{ "device_id": "01JC…", "ops": [ … ] }` (the file from [03 §8](03-sync.md#8-device-revocation-and-data-loss-window); ≤ 200 ops per call, sent in chunks) → same response shape as push. `404 NOT_FOUND` if the device is not in the caller's tenant, `403 FORBIDDEN` if it is not revoked.

`POST /api/shop/conflicts/:id/acknowledge` → `200` (sets `resolution = 'acknowledged'`, appends `change_log`; `403 TENANT_READ_ONLY` in a read-only shop).

## 4. Request validation

The Worker validates the **HTTP request envelope** with Zod (`apps/api/src/sync/opSchema.ts` and the `z.object` bodies in `routes/`). It does not validate synced rows with per-table Zod schemas.

Row payloads go through:

- an allow-list of columns from `packages/db/src/tables.ts` (`writableColumns` drops `tenant_id`, `rev`, `products.avg_cost`, `sales.status` and unknown keys);
- `checkOp` in `apps/api/src/sync/applyOps.ts`: row ids, scalar-only values, safe integers, strings capped at 4,000 characters, required parent/source rows, permissions and the table-specific checks in §5;
- the D1 constraints: `STRICT` tables, `CHECK`s, composite foreign keys and unique indexes.

The client does the cheap equivalent on pull: `assertServerRow` in `apps/pos/src/sync/merge.ts` checks scalar values and bounded strings, and a row-shaped failure is quarantined by `applyPage` rather than aborting the whole page.

This is deliberate ([D-170](decisions.md#decisions-log)). A second per-table schema layer would duplicate D1 and `packages/core` invariants, add Worker CPU and client bundle cost, and create an old-client/new-server compatibility trap for offline tills.

The actual request-envelope schemas (excerpt):

```ts
export const PushOpSchema = z.object({
  op_id: Ulid,
  tx_id: Ulid,
  tbl: z.string().max(40),
  kind: z.enum(['insert', 'upsert', 'delete']),
  row: z.record(z.string(), z.unknown()).optional(),
  row_id: RowId.optional(),
  base_rev: z.number().int().min(0).optional(),
  changed_fields: z.array(z.string().max(40)).max(80).optional(),
  updated_by: z.string().max(40).nullable().optional(),
  created_at: z.number().int().optional(),
});

export const PushBody = z.object({
  device_id: Ulid,
  schema_version: z.number().int(),
  app_version: z.string().max(20),
  ops: z.array(PushOpSchema).min(1).max(200),
});

export const PullQuery = z.object({
  since: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
```

`Ulid` and `RowId` are defined at the top of `opSchema.ts`. Every route parses its body/query before doing any work; parse failures become `400 VALIDATION_FAILED` with the failing path and no echoed input.

## 5. Server-side checks beyond the request envelope

| Check | Applies to | Error |
|---|---|---|
| Every row is written with the authenticated device's `tenant_id`; references to ids that are not in that tenant fail the composite foreign keys | all ops | `FOREIGN_KEY` |
| `row.device_id` equals the authenticated device | all ledger inserts that have `device_id` | `FORBIDDEN` |
| `row.staff_id` is an active staff member **of the same tenant** | ledger inserts | `FORBIDDEN` |
| `tbl` is a master or ledger table | all ops | `UNKNOWN_TABLE` |
| `created_at` ≤ server time + 24 h | all inserts | `CONSTRAINT_FAILED` |
| Staff role permits the action ([05 §5](05-auth-and-roles.md#5-server-side-enforcement)) | refunds, voids, staff/shop/branch upserts, deletes | `FORBIDDEN` |
| The branch exists; the invoice's device code is the device's current or historical code; a sale for another branch is accepted only when it was created before the device's branch move | `sales` | `CONSTRAINT_FAILED` |
| Ledger table with kind ≠ insert | all | `IMMUTABLE_TABLE` |
| Refund qty per line ≤ sold qty − already refunded | `refund_lines` | **accepted**, plus a `sync_conflicts` row `over_refund` ([03 §5](03-sync.md#5-conflict-rules)); a refund or void arriving for an already-voided sale → `refund_after_void`. Real money events are never rejected. |
| Refund split: `udhaar_part` ≤ the sale's remaining udhaar, and `udhaar_part > 0` only if the sale has a customer | `refunds` | `CONSTRAINT_FAILED` (an `amount` above the remaining paid amount is **accepted** and flagged `over_refund`, like any real money event) |
| `refunds.amount > 0` has exactly one `payments` row (out, `refund`, same method and amount) and `udhaar_part > 0` exactly one customer `ledger_entries` row (−udhaar_part), in the same batch or already stored | `refunds` | `CONSTRAINT_FAILED` |
| `supplier_return_lines.line_total = mulDivRound(qty_milli, unit_credit, 1000)`, `Σ line_total = supplier_returns.total`, `line_count` matches; a linked `purchase_line_id` belongs to a purchase of the same `supplier_id` | `supplier_returns`, `supplier_return_lines` | `CONSTRAINT_FAILED` (returned qty above received − already returned is **accepted** and flagged `over_return`) |
| `supplier_returns.refund_received > 0` has exactly one `payments` row (in, `supplier_refund`, same method and amount, `supplier_return_id`), in the same batch or already stored | `supplier_returns` | `CONSTRAINT_FAILED` |
| Every `ledger_entries` row is backed by its source row in the same batch (sale, refund, void, payment, purchase or supplier return), with the source's customer/supplier and amount | `ledger_entries` | `CONSTRAINT_FAILED` |
| A `customer`/`supplier` party exists in the tenant (in D1 or earlier in the same push); payment directions match their purpose (`sale`/`customer_payment`/`supplier_refund` are `in`, `refund`/`void`/`supplier_payment`/`purchase_paid_now` are `out`) | `payments`, `ledger_entries` | `CONSTRAINT_FAILED` |
| At least one active owner remains after the action | `staff` | `CONSTRAINT_FAILED` |
| `payments.purpose` that names a document (`sale`, `refund`, `purchase_paid_now`, `supplier_refund`, `void`) has that document in the same batch; customer/supplier payments have their `ledger_entries` row in the same batch | `payments` | `CONSTRAINT_FAILED` |
| Child lines (`sale_lines`, `refund_lines`, `purchase_lines`, `supplier_return_lines`) have their parent header in the same batch | child rows | `CONSTRAINT_FAILED` |
| `day_closes.period_end = created_at`, `period_start ≤ period_end`, and the staff has `dayclose.create` | `day_closes` | `CONSTRAINT_FAILED` / `FORBIDDEN` |
| Stock movements have the sign required by their reason (`sale`/`supplier_return` negative, `opening`/`purchase`/receipts positive) and a non-negative integer cost for stock-adding reasons | `stock_movements` | `CONSTRAINT_FAILED` |
| Ops imported through `POST /api/shop/import-ops` or `/api/admin/tenants/:id/import-ops` | ops of a revoked device of that tenant | `device_id` must be that revoked device instead of the caller |

## 6. Rate limits

Optional Cloudflare WAF rate-limiting rule on the `algovyn.com` zone: the **Free plan allows one rule, counting by IP, with a fixed 10-second period and 10-second block** (longer windows need Pro). If the website does not already use that one rule: path equals `/bikri/api/devices/enrol`, 5 requests per 10 s per IP → block 10 s. The real protection is the code itself (≈10¹² combinations, single use, 15-minute expiry) plus the Worker's own check: more than 5 failed enrolment attempts per IP per 15 minutes → `429 RATE_LIMITED`, counted in an in-memory map per isolate (best effort). Per-tenant fairness is handled by the daily write budget and `poll_after_ms` ([13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)), not by IP rate limits (a shop's tills often share one IP). Owner email sign-in has its own limits (per device, per shop, per IP through the Workers Rate Limiting binding `OWNER_SIGNIN_LIMIT`, [05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082)); the owner's server export is limited to one start per shop per 24 hours ([13 §7.3](13-multi-tenancy.md#73-per-tenant-export-and-restore)).
