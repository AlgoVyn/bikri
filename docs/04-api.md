# 04 — API

Base URL: `https://algovyn.com/bikri/api` (path-based, see [01 §1.1](01-architecture.md#11-url-layout-and-the-path-convention-used-in-these-docs)). Paths below and elsewhere in the docs (`/api/sync/push` etc.) are relative to the `/bikri` base path; in code use `API_BASE` from `packages/core/src/paths.ts`. Same origin as the app, so no CORS. All bodies are JSON (`Content-Type: application/json; charset=utf-8`) except file upload/download.

## 1. Endpoint list

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness and versions |
| POST | `/devices/enrol` | none (rate-limited) | Exchange an enrolment code for a device token |
| GET | `/me` | device | Device, branch and setup status |
| POST | `/sync/push` | device | Push outbox ops ([03 §4.1](03-sync.md#41-push--post-apisyncpush)) |
| GET | `/sync/pull` | device | Pull changes since a cursor ([03 §4.2](03-sync.md#42-pull--get-apisyncpullsinceseqlimit500)) |
| GET | `/sync/snapshot` | device | Full copy of the synced tables, paged per table, for new or stale tills ([03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot)) |
| PUT | `/files/:kind/:id/:sha256` | device | Upload a product image or logo |
| GET | `/files/*key` | device | Download a file from R2 |
| GET | `/admin/session` | Access | Who is signed in to admin |
| POST | `/admin/devices/enrol-this-browser` | Access | Enrol the current browser directly |
| POST | `/admin/enrolment-codes` | Access | Create a one-time 8-char enrolment code |
| GET | `/admin/devices` | Access | List devices |
| PATCH | `/admin/devices/:id` | Access | Rename / move branch |
| POST | `/admin/devices/:id/revoke` | Access | Revoke a device |
| GET | `/admin/backups` | Access | List backup objects in R2 |
| GET | `/admin/backups/*key` | Access | Download a backup |
| GET | `/admin/conflicts` | Access | Recent `sync_conflicts` (last 200) |
| POST | `/admin/reset-owner-pin` | Access | Set a new owner PIN when it is forgotten |
| POST | `/admin/import-ops` | Access | Import the unsynced-ops file of a revoked device ([03 §8](03-sync.md#8-device-revocation-and-data-loss-window)) |

## 2. Conventions

- **Auth header (device):** `Authorization: Bearer <device_token>` where the token is 43 base64url chars (32 random bytes).
- **Auth (admin):** Cloudflare Access adds `Cf-Access-Jwt-Assertion`; the Worker verifies it ([05 §3](05-auth-and-roles.md#3-owner-admin-via-cloudflare-access)).
- **Version headers:** the till sends `X-Bikri-App: 0.1.0` and `X-Bikri-Schema: 1` on every request.
- **Times** are epoch ms. **Money** is paisa integers.
- **Error shape** (all non-2xx):

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "ops[3].row.price must be >= 0", "details": { "path": ["ops", 3, "row", "price"] } } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body/query fails Zod |
| 400 | `BAD_ENROLMENT_CODE` | Code unknown, used or expired |
| 401 | `UNAUTHENTICATED` | Missing/unknown token or Access JWT |
| 401 | `DEVICE_REVOKED` | Token belongs to a revoked device |
| 403 | `FORBIDDEN` | Access email not in `OWNER_EMAILS`, or permission failure |
| 404 | `NOT_FOUND` | File or device not found |
| 409 | `SCHEMA_OUTDATED` | Client schema version < `MIN_CLIENT_SCHEMA` |
| 410 | `SNAPSHOT_REQUIRED` | Pull `since` is below `meta.change_log_floor` (changes pruned after 30 days); `details.change_log_floor` |
| 413 | `PAYLOAD_TOO_LARGE` | Push body > 1 MB, image > 2 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Upload not webp/png/jpeg |
| 429 | `RATE_LIMITED` | Too many requests (see §6) |
| 500 | `INTERNAL` | Unexpected; includes `details.request_id` |
| 503 | `MAINTENANCE` | Worker var `MAINTENANCE=1` during a restore; client keeps ops, retries after `Retry-After: 300` |
| 503 | `D1_LIMIT` | D1 daily free limit reached; client keeps ops and retries after `Retry-After` |

Per-op errors inside a push response use `error_code`: `CONSTRAINT_FAILED`, `UNIQUE_VIOLATION`, `FOREIGN_KEY`, `FORBIDDEN`, `IMMUTABLE_TABLE` (update/delete attempted on a ledger table), `UNKNOWN_TABLE`, `SETUP_ALREADY_DONE` (a `shop` insert when `setup_completed_at` is already set).

## 3. Endpoints

### 3.1 `GET /api/health`
```json
200 { "ok": true, "app_version": "0.1.0", "schema_version": 1, "min_client_schema": 1, "db": "ok", "time": 1793050000000 }
```

### 3.2 `POST /api/devices/enrol`
Request:
```json
{ "code": "K7Q2-M9XD", "user_agent": "Mozilla/5.0 ...", "app_version": "0.1.0" }
```
Response `201`:
```json
{
  "device": { "id": "01JC0Z8K3V7R1M2Q4S6T8V0X2Y", "name": "Counter 1", "branch_id": "01JC0Y...", "device_code": "A", "last_invoice_seq": 0 },
  "token": "q3J4m...43chars",
  "shop_setup_completed": false
}
```
Errors: `400 BAD_ENROLMENT_CODE`, `429 RATE_LIMITED`. The code is single-use and valid 15 minutes. The plain token is returned **once** and stored only as a SHA-256 hash.

### 3.3 `GET /api/me`
```json
200 {
  "device": { "id": "01JC0Z...", "name": "Counter 1", "branch_id": "01JC0Y...", "device_code": "A", "revoked": false },
  "shop_setup_completed": true,
  "server_time": 1793050000000,
  "latest_seq": 48213
}
```

### 3.4 `POST /api/sync/push` and `GET /api/sync/pull`
Specified in [03-sync §4](03-sync.md#4-protocol). Limits: ≤ 200 ops, ≤ 1 MB body; `limit` for pull 1–1000 (default 500).

`GET /api/sync/snapshot` and `GET /api/sync/snapshot?tbl=&after=&limit=` are specified in [03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot). `tbl` must be one of the snapshot tables (else `400 VALIDATION_FAILED`); `after` is an id (empty = from the start); `limit` 1–1000 (default 500).

### 3.5 `PUT /api/files/:kind/:id/:sha256`
- `kind` ∈ `product_image`, `logo`. `id` = product ID (or `shop` for logo). `sha256` = hex digest of the body (client computes).
- Body: raw bytes, `Content-Type: image/webp | image/png | image/jpeg`, ≤ 2 MB (client resizes first: product images 512×512 max WebP q=0.8; logo PNG ≤ 576 px wide).
- Server verifies the digest, writes R2 key `products/<id>/<sha256>.webp` or `shop/logo-<sha256>.png`, returns:
```json
201 { "key": "products/01J9.../9f2c...e1.webp", "size": 24311 }
```
The till then upserts `products.image_key` / `shop.logo_key` through the normal sync path. Uploading the same digest twice is a no-op `200`.

### 3.6 `GET /api/files/*key`
Streams the R2 object from `FILES` with `Cache-Control: private, max-age=31536000, immutable` and `ETag`. **Only keys matching `^products/[0-9A-HJKMNP-TV-Z]{26}/[0-9a-f]{64}\.webp$` or `^shop/logo-[0-9a-f]{64}\.png$` are served**; anything else → `404 NOT_FOUND`. Backups live in the separate `bikri-backups` bucket and are reachable only through `/api/admin/backups/*`. Keys are content-addressed, so they never change.

### 3.7 Admin endpoints (Cloudflare Access)

`GET /api/admin/session` → `200 { "email": "adnan@yaqoob.org" }`

`POST /api/admin/devices/enrol-this-browser`
```json
{ "name": "Counter 1", "branch_id": "01JC0Y..." }   // branch_id optional: default branch, created if none exists
→ 201 { "device": { ... }, "token": "...", "shop_setup_completed": false }
```
Used when the owner opens `/admin` on the till itself. If no branch exists yet, the Worker creates the default branch `{ name: 'Main', bill_prefix: 'INV', is_default: 1 }` and appends it to `change_log`.

`POST /api/admin/enrolment-codes`
```json
{ "device_name": "Counter 2", "branch_id": "01JC0Y..." }
→ 201 { "code": "K7Q2-M9XD", "expires_at": 1793050900000 }
```
Code alphabet: `23456789ABCDEFGHJKMNPQRSTVWXYZ` (30 symbols, no `0 O 1 I L U`, matching [screens/02](screens/02-enrol.md)); 8 chars (30⁸ ≈ 6.6 × 10¹¹) shown as `XXXX-XXXX`. Codes are generated with `crypto.getRandomValues` and rejection sampling.

`DELETE /api/admin/enrolment-codes/:code` → `204` (cancel an unused code; the admin page lists active codes from `GET /api/admin/enrolment-codes`, returning `{ codes: [ { code_hint: 'K7Q2-…', device_name, expires_at } ] }`; only the hash is stored, so the page keeps the plain code in memory until it expires).

`GET /api/admin/devices` → `200 { "devices": [ { "id", "name", "branch_id", "device_code", "enrolled_at", "last_seen_at", "app_version", "revoked_at" } ] }`

`PATCH /api/admin/devices/:id` `{ "name"?: string, "branch_id"?: string }` → `200 { "device": {...} }`. Moving a device to another branch assigns it a **new** `device_code` in the target branch (codes are never reused), so invoice numbers stay unique; the till picks up the new code on its next `/api/me` and continues its own `invoice_seq`.

`POST /api/admin/devices/:id/revoke` → `200 { "revoked_at": 1793050000000 }`

`GET /api/admin/backups?prefix=d1/` (bucket `bikri-backups`; downloads are sent with `Cache-Control: no-store` and `Content-Disposition: attachment`) → `200 { "objects": [ { "key": "d1/2026-10-27.sql.gz", "size": 4810233, "uploaded": 1793050000000 } ] }`

`POST /api/admin/import-ops` `{ "device_id": "01JC…", "ops": [ … ] }` (the file from [03 §8](03-sync.md#8-device-revocation-and-data-loss-window); ≤ 200 ops per call, the admin page sends the file in chunks) → same response shape as push. `403 FORBIDDEN` if the device is not revoked.

`POST /api/admin/reset-owner-pin` `{ "staff_id": "01JB...", "pin_hash": "<base64>", "pin_salt": "<base64>", "pin_iterations": 150000 }` → the **admin page in the browser** computes the PBKDF2 hash with WebCrypto (the Worker never hashes PINs, to stay inside the 10 ms CPU limit); the Worker upserts the staff row with `rev+1`, appends `change_log` and an `audit_log` row (`pin_reset`) → `200 { "ok": true }`.

## 4. Zod schemas (excerpt, `packages/core/schemas`)

Every table has a schema generated from one table-metadata definition in `packages/db/src/tables.ts` so D1, Dexie and Zod never drift. Example shapes:

```ts
import { z } from 'zod';

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
// Not every id is a ULID: shop.id is 'shop', system expense_categories use their code as id,
// and server-originated rows use device_id / staff_id = 'server' (05 §3).
export const RowId = z.union([Ulid, z.literal('shop'), z.string().regex(/^[a-z_]{2,30}$/)]); // per-table schemas narrow this
export const ActorId = z.union([Ulid, z.literal('server')]); // device_id, staff_id, updated_by on rows the server may write
export const Paisa = z.number().int().safe();
export const PaisaNonNeg = Paisa.min(0);
export const QtyMilli = z.number().int().positive();
export const Bp = z.number().int().min(0).max(10000);
export const EpochMs = z.number().int().min(0); // 0 only on seed rows; the server rejects created_at more than 24 h in the future
export const BusinessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Method = z.enum(['cash', 'card', 'bank_wallet']);

export const SaleRow = z.object({
  id: Ulid,
  invoice_no: z.string().regex(/^[A-Z0-9]{1,6}-[A-Z]{1,2}-\d+$/),
  invoice_seq: z.number().int().positive(),
  branch_id: Ulid, device_id: Ulid, staff_id: Ulid,
  customer_id: Ulid.nullable(),
  business_date: BusinessDate, created_at: EpochMs,
  line_count: z.number().int().positive(), items_qty_milli: QtyMilli,
  gross_total: PaisaNonNeg, item_discount_total: PaisaNonNeg, subtotal: PaisaNonNeg,
  bill_discount_type: z.enum(['rs', 'pct']).nullable(), bill_discount_value: z.number().int().min(0),
  bill_discount: PaisaNonNeg, tax_rate_bp: Bp, tax: PaisaNonNeg, tax_inclusive: z.union([z.literal(0), z.literal(1)]), rounding: Paisa,
  total: PaisaNonNeg, paid_total: PaisaNonNeg, udhaar_amount: PaisaNonNeg,
  cash_tendered: PaisaNonNeg, change_given: PaisaNonNeg,
  replaces_sale_id: Ulid.nullable(), note: z.string().max(200),
  status: z.enum(['paid', 'part_refunded', 'refunded', 'void']).optional(), // derived: ignored on push, present on pull
}).superRefine((s, ctx) => {
  const taxAdded = s.tax_inclusive === 1 ? 0 : s.tax; // inclusive (MRP) prices already contain the tax, 07 §3
  if (s.total !== s.subtotal - s.bill_discount + taxAdded + s.rounding) ctx.addIssue({ code: 'custom', message: 'total mismatch' });
  if (s.paid_total + s.udhaar_amount !== s.total) ctx.addIssue({ code: 'custom', message: 'payment mismatch' });
});

export const RefundRow = z.object({
  id: Ulid, sale_id: Ulid, kind: z.enum(['whole', 'partial']), reason: z.string().min(1).max(120),
  method: Method.nullable(),               // null = whole refund goes to khata (07 §6.1)
  exact_amount: z.number().int().positive(), udhaar_part: PaisaNonNeg, rounding: Paisa, amount: PaisaNonNeg,
  branch_id: Ulid, device_id: Ulid, staff_id: Ulid, business_date: BusinessDate, created_at: EpochMs,
}).superRefine((r, ctx) => {
  if (r.amount !== r.exact_amount - r.udhaar_part + r.rounding) ctx.addIssue({ code: 'custom', message: 'refund amount mismatch' });
  if ((r.method === null) !== (r.exact_amount - r.udhaar_part === 0)) ctx.addIssue({ code: 'custom', message: 'method required iff a paid part exists' });
  if (r.method !== 'cash' && r.rounding !== 0) ctx.addIssue({ code: 'custom', message: 'rounding only for cash' });
});

export const SupplierReturnRow = z.object({
  id: Ulid, supplier_id: Ulid, purchase_id: Ulid.nullable(), reason: z.string().min(1).max(120),
  total: z.number().int().positive(), refund_received: PaisaNonNeg, refund_method: z.enum(['cash', 'bank_wallet']).nullable(),
  line_count: z.number().int().positive(), note: z.string().max(200),
  branch_id: Ulid, device_id: Ulid, staff_id: Ulid, business_date: BusinessDate, created_at: EpochMs,
}).superRefine((r, ctx) => {
  if (r.refund_received > r.total) ctx.addIssue({ code: 'custom', message: 'refund_received > total' });
  if ((r.refund_received === 0) !== (r.refund_method === null)) ctx.addIssue({ code: 'custom', message: 'refund_method iff refund_received > 0' });
});
export const SupplierReturnLineRow = z.object({
  id: Ulid, return_id: Ulid, line_no: z.number().int().min(1), product_id: Ulid, purchase_line_id: Ulid.nullable(),
  qty_milli: QtyMilli, unit_credit: PaisaNonNeg, line_total: PaisaNonNeg, cost_snapshot: PaisaNonNeg, created_at: EpochMs,
});
export const SnapshotQuery = z.object({ tbl: z.enum(SNAPSHOT_TABLES).optional(), after: z.string().max(40).default(''), limit: z.coerce.number().int().min(1).max(1000).default(500) });

export const OpInsert = z.object({ op_id: Ulid, tbl: z.enum(LEDGER_TABLES), kind: z.literal('insert'), row: z.record(z.string(), z.unknown()) });
export const OpUpsert = z.object({ op_id: Ulid, tbl: z.enum(MASTER_TABLES), kind: z.literal('upsert'), base_rev: z.number().int().min(0), changed_fields: z.array(z.string()).max(50), row: z.record(z.string(), z.unknown()) });
export const OpDelete = z.object({ op_id: Ulid, tbl: z.enum(MASTER_TABLES), kind: z.literal('delete'), row_id: Ulid, base_rev: z.number().int().min(0) });
export const PushBody = z.object({
  device_id: Ulid, schema_version: z.number().int(), app_version: z.string().max(20),
  ops: z.array(z.discriminatedUnion('kind', [OpInsert, OpUpsert, OpDelete])).min(1).max(200),
});
export const PullQuery = z.object({ since: z.coerce.number().int().min(0), limit: z.coerce.number().int().min(1).max(1000).default(500) });
export const EnrolBody = z.object({ code: z.string().regex(/^[2-9A-HJKMNP-TV-Z]{4}-?[2-9A-HJKMNP-TV-Z]{4}$/i), user_agent: z.string().max(400), app_version: z.string().max(20) });
```

After the op-level parse, the server parses `row` with the table's row schema (e.g. `SaleRow`) and rejects the op on failure with `CONSTRAINT_FAILED`.

## 5. Server-side checks beyond Zod

| Check | Applies to | Error |
|---|---|---|
| `row.device_id` equals the authenticated device | all ledger inserts that have `device_id` | `FORBIDDEN` |
| `row.staff_id` is an active staff member | ledger inserts | `FORBIDDEN` |
| `tbl` is a master or ledger table | all ops | `UNKNOWN_TABLE` |
| `created_at` ≤ server time + 24 h | all inserts | `CONSTRAINT_FAILED` |
| Staff role permits the action ([05 §5](05-auth-and-roles.md#5-server-side-enforcement)) | refunds, voids, staff/shop/branch upserts, deletes | `FORBIDDEN` |
| Invoice prefix and device code match the device's branch/code | `sales` | `CONSTRAINT_FAILED` |
| Ledger table with kind ≠ insert | all | `IMMUTABLE_TABLE` |
| Refund qty per line ≤ sold qty − already refunded | `refund_lines` | **accepted**, plus a `sync_conflicts` row `over_refund` ([03 §5](03-sync.md#5-conflict-rules)); a refund or void arriving for an already-voided sale → `refund_after_void`. Real money events are never rejected. |
| Refund split: `udhaar_part` ≤ the sale's remaining udhaar, and `udhaar_part > 0` only if the sale has a customer | `refunds` | `CONSTRAINT_FAILED` (an `amount` above the remaining paid amount is **accepted** and flagged `over_refund`, like any real money event) |
| `refunds.amount > 0` has exactly one `payments` row (out, `refund`, same method and amount) and `udhaar_part > 0` exactly one customer `ledger_entries` row (−udhaar_part), in the same batch or already stored | `refunds` | `CONSTRAINT_FAILED` |
| `supplier_return_lines.line_total = mulDivRound(qty_milli, unit_credit, 1000)`, `Σ line_total = supplier_returns.total`, `line_count` matches; a linked `purchase_line_id` belongs to a purchase of the same `supplier_id` | `supplier_returns`, `supplier_return_lines` | `CONSTRAINT_FAILED` (returned qty above received − already returned is **accepted** and flagged `over_return`) |
| `supplier_returns.refund_received > 0` has exactly one `payments` row (in, `supplier_refund`, same method and amount, `supplier_return_id`), in the same batch or already stored | `supplier_returns` | `CONSTRAINT_FAILED` |
| Ops pushed through `POST /api/admin/import-ops` | ops of a revoked device | `device_id` must be that revoked device instead of the caller |

## 6. Rate limits

Optional Cloudflare WAF rate-limiting rule on the `algovyn.com` zone: the **Free plan allows one rule, counting by IP, with a fixed 10-second period and 10-second block** (longer windows need Pro). If the website does not already use that one rule: path equals `/bikri/api/devices/enrol`, 5 requests per 10 s per IP → block 10 s. The real protection is the code itself (≈10¹² combinations, single use, 15-minute expiry) plus the Worker's own check: more than 5 failed enrolment attempts per IP per 15 minutes → `429 RATE_LIMITED`, counted in an in-memory map per isolate (best effort).
