# 05 — Auth and roles

Bikri is multi-tenant ([13](13-multi-tenancy.md)): every till, staff member, PIN and permission belongs to exactly one **tenant** (shop). There are four layers:

1. **Device token** — proves a browser is an enrolled till **of one tenant**. Required for all till API calls; the Worker derives the tenant from it (`devices.token_hash` → `devices.tenant_id`).
2. **Staff PIN** — says which person of that shop is using the till. Checked on the device, works offline. Staff, roles and PINs are per tenant.
3. **Admin device** — a till with `devices.is_admin = 1` may also call the **shop-admin API** (`/api/shop/*`) for its own tenant: enrolment codes, devices, conflicts, unsynced-ops import (§3).
4. **Cloudflare Access** — protects the **platform operator console** (`https://algovyn.com/bikri/admin*`, `https://algovyn.com/bikri/api/admin/*`) with email one-time PIN. The only allowed email is **`operator@example.com`** (D-022). The operator is not a staff member of any shop.

Paths in this doc are relative to the `/bikri` base path ([01 §1.1](01-architecture.md#11-url-layout-and-the-path-convention-used-in-these-docs)). The till paths (`/bikri/`, `/bikri/api/sync/*`, `/bikri/api/files/*`, `/bikri/api/me`, `/bikri/api/shop/*`) and the rest of `algovyn.com` are **not** behind Access, because Access login redirects would break offline service-worker requests.

## 0. Roles

| Role | Scope | Who | How they authenticate |
|---|---|---|---|
| **Platform operator** | the whole deployment | `operator@example.com` | Cloudflare Access (email OTP) on `/admin*`; `OWNER_EMAILS` secret. Renamed in docs from "owner admin"; the secret keeps its name |
| **Owner** | one tenant | shop owner | device token + PIN; shop-admin actions only on an admin device |
| **Manager** | one tenant | senior staff | device token + PIN |
| **Cashier** | one tenant | counter staff | device token + PIN |

A person who works in two shops has two separate `staff` rows (one per tenant) and uses each shop's own tills. Adnan running his own shop is a normal shop owner of that tenant, plus the operator in the console.

## 1. Threat model (what we defend against)

| Threat | Mitigation |
|---|---|
| Stranger calls the API | Device token required; 32 random bytes; only hash stored |
| **A shop reads or changes another shop's data** (bug or malicious till) | Tenant derived only from the token; `tenant_id` never accepted from requests; composite primary and foreign keys `(tenant_id, …)` so SQLite rejects cross-tenant references; every query through the tenant-scoped data layer ([13 §5](13-multi-tenancy.md#5-tenant-scoping-rules-for-implementers)); R2 keys prefixed by the server; per-tenant Dexie database on the till. **The cross-tenant isolation suite ([10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory)) is mandatory and runs in CI on every PR.** |
| Guessing another shop's ids | Ids are only meaningful inside the caller's tenant: a guessed ULID either does not exist in the caller's tenant (FK failure, `404`) or names the caller's own row. Error messages never say whether an id exists in another tenant |
| One shop exhausts the shared free tier | Per-tenant daily write budget, `503 TENANT_QUOTA`, per-tenant poll interval ([13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)) |
| Stolen/lost till | Shop owner revokes it in Settings → Devices (admin device), or the operator in the console; token stops working immediately |
| Cashier gives unauthorised discounts/refunds | Role permissions on device and server; manager PIN override; audit log |
| Cashier sees cost/margin | `cost.view` permission; cost hidden in UI |
| Cashier uses the shop-admin API (enrol extra devices, revoke tills) | Only admin devices may call `/api/shop/*`; the UI requires an owner PIN unlock on that device; every call writes an `audit_log` row. A cashier with technical skill and physical access to an **unlocked admin device's** browser could still call it (the PIN is checked only on the device): keep admin devices to the owner's own PC/phone. Stronger owner sign-in is an open question ([13 §9](13-multi-tenancy.md#9-open-questions-owner-decision-needed)) |
| Someone with the PC reads IndexedDB | **Not defended** (no encryption at rest). Use a Windows account password. Documented risk. This includes the device token and every staff `pin_hash`: a 4–6 digit PIN hashed with PBKDF2 can be brute-forced offline in minutes, so the PIN only stops casual use at the counter. The operator console (Cloudflare Access) does not depend on PINs. |
| Another page on `algovyn.com` reads Bikri's storage | Same origin as the website; mitigations in [01 §5.4](01-architecture.md#54-same-origin-as-the-website-storage-permissions-cookies-cors) (no third-party JS anywhere on `algovyn.com`). |
| Cross-site request forgery on the operator API (cookie-authenticated) | `sameOrigin` check on `/api/admin/*` ([01 §5](01-architecture.md#5-worker-and-hono)); till and shop-admin APIs use bearer tokens, not cookies. |
| A till claims another staff member's `staff_id` | Not defended server-side beyond "the staff row exists, is active and belongs to the same tenant" (PINs are checked only on the device); the audit trail records device + staff. Accepted for a shop's own trusted staff. |
| Brute force of a 4-digit PIN on the device | Lockout after 5 wrong tries for 5 minutes, doubling each time (max 1 h). PIN is a convenience lock, not encryption. |
| Brute force of enrolment codes | 8 chars from 30 symbols (≈ 6.6 × 10¹¹), 15-minute expiry (72 h for owner pairing codes), single use, WAF rate limit + per-IP counter. A code enrols into the tenant it was created for; a guessed code from another shop would join that shop, so codes are never shown in logs or URLs other than the enrol link |
| The operator reads shop data | Not prevented technically (the operator runs D1 and holds the backup key). Operator exports and imports are logged in that tenant's `audit_log` (`operator_export`, `operator_import`), visible to the shop owner in Settings → Activity. Policy questions in [13 §9](13-multi-tenancy.md#9-open-questions-owner-decision-needed) |

## 2. Device enrolment

Every device is enrolled with a one-time **enrolment code**, which is tied to one tenant and one branch. There is no vendor account or activation (REQ-B05), and no Cloudflare Access login for shop owners.

**A. First device of a new shop (owner pairing code).**
1. The operator creates the tenant in the console; it returns an **owner pairing code** (`grants_admin = 1`, valid 72 hours) and the link `https://algovyn.com/bikri/enrol?code=K7Q2M9XD` ([13 §7.1](13-multi-tenancy.md#71-onboarding-a-new-shop-d-072)).
2. The shop owner opens the link (or types the code on the [enrol screen](screens/02-enrol.md)) → `POST /api/devices/enrol` → the device becomes the shop's first **admin device**; the response includes the tenant (`id`, `display_name`).
3. The browser opens the tenant's Dexie database `bikri-<tenant_id>`, stores the token and goes to the [setup wizard](screens/01-setup-wizard.md) (`shop_setup_completed = false`), which creates the shop profile and the owner PIN.

**B. More tills (shop owner).**
1. On an admin device, unlocked as an owner: Settings → Devices → "Add a till" → name, branch, "Can manage devices" (admin, off by default) → `POST /api/shop/enrolment-codes` → code `K7Q2-M9XD` + QR of the enrol link, valid 15 minutes.
2. On the new device: open `algovyn.com/bikri` → enrol screen → type or scan the code → `POST /api/devices/enrol` → initial sync (snapshot, [03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot)) → PIN lock.

**C. Operator-issued codes.** The operator can also issue a code for any tenant from the console (e.g. a replacement owner pairing code when the owner lost every admin device).

Device codes are assigned per branch (per tenant) in order A, B, … Z, AA, AB … and never reused, even after revocation. A browser holds one tenant at a time (D-073): enrolling a browser that already belongs to another shop is refused on the device ("This browser is connected to <shop>. Leave that shop first.") until it has no unsynced ops (or they were exported) and the user chose Settings → Device → "Leave this shop", which deletes that tenant's Dexie database.

## 3. Shop admin on admin devices

- Endpoints `/api/shop/*` ([04 §3.8](04-api.md#38-shop-admin-endpoints-admin-device)) require a valid device token **and** `devices.is_admin = 1`, and the header `X-Bikri-Staff: <staff_id>` naming an active `owner` of the same tenant (the UI sends it only after an owner PIN unlock). Otherwise `403 FORBIDDEN`.
- Features: create/cancel enrolment codes (admin or not), list/rename/move/revoke devices, make a device admin or not (at least one non-revoked admin device must remain), import a revoked device's unsynced ops, list and acknowledge sync conflicts. Every call writes an `audit_log` row (`device_enrol_code`, `device_change`, `device_revoke`, `ops_import`), pulled to all tills like any other row.
- Forgotten **owner** PIN: another `owner` of the shop resets it in Settings → Cashiers; if there is none, the operator resets it from the console after confirming the owner's identity out of band (`POST /api/admin/tenants/:id/reset-owner-pin`).

## 3.1 Platform operator via Cloudflare Access

- Access application: self-hosted, hostname `algovyn.com`, destinations `bikri/admin`, `bikri/admin/*`, `bikri/api/admin`, `bikri/api/admin/*` (setup steps in [01 §7.1](01-architecture.md#71-one-time-setup-platform-operator)). Policy: Allow, Include → Emails → `operator@example.com`. Identity: One-time PIN. Session duration 24 h. No other part of `algovyn.com` is behind Access.
- `OWNER_EMAILS` Worker secret = `operator@example.com` (the operator list; name kept from M0). Adding an operator later means changing **both** the Access policy and this secret ([09](09-backups-and-ops.md)).
- Links from the till UI to the console must be **full page navigations** (`window.location.assign('/bikri/admin')`), never client-side router navigation, so the request reaches Cloudflare Access. When an admin API call returns `401`, or a redirect to `*.cloudflareaccess.com` (fetch with `redirect: 'manual'` gives an `opaqueredirect` response), the console reloads itself to start a new Access login.
- The console is a separate route tree in the same PWA (`/bikri/admin/*`), not precached by the service worker (always online). It never opens or writes a tenant Dexie database.
- Worker verification (`accessAuth` middleware): read `Cf-Access-Jwt-Assertion`; fetch JWKS from `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (cache 1 h in module scope); verify RS256 signature, `aud` contains `ACCESS_AUD`, `iss` = `https://${ACCESS_TEAM_DOMAIN}`, `exp` in the future, `email` in `OWNER_EMAILS`. Otherwise `401 UNAUTHENTICATED` / `403 FORBIDDEN`. Tenant-specific operator routes take the tenant from the path (`/api/admin/tenants/:id/…`) and check it exists.
- Server-originated rows (default branch at tenant creation, PIN reset audit, operator imports) use `device_id = 'server'` and `staff_id` = the tenant's owner staff row (or `'server'` before setup), always with that tenant's `tenant_id`.

Operator features (v1, [screens/19](screens/19-admin.md)): tenants (create with owner pairing code, edit budget/poll interval, suspend, reactivate, delete), per-tenant devices (list, revoke, issue a code), per-tenant usage vs budget and account-wide usage, backups (list, download), per-tenant export, restore and unsynced-ops import, per-tenant owner PIN reset, conflicts counts.

## 4. Staff PINs and session

- PIN: 4 digits by default (owner can allow 4–6 per person). Stored as PBKDF2-SHA256, 150,000 iterations, 16-byte random salt, 32-byte output, base64 (`staff.pin_hash`, `pin_salt`, `pin_iterations`). Hashing happens in the browser with WebCrypto.
- Weak PINs rejected at creation: `0000`, `1111`…`9999`, `1234`, `4321`, `1212`, the year `19xx/20xx` patterns, and any PIN already used by another active staff member of this shop (tenant). Staff of different shops are unrelated.
- Unlock: pick profile chip → type PIN → compare hash locally. On success set `session = { staff_id, role, unlocked_at }` in memory (not persisted).
- Auto-lock: after 10 minutes without input (configurable 2–60, or "never" for owner), and on `Ctrl+L` / rail avatar → Lock.
- Switching cashier keeps carts and held bills; new lines and the eventual sale record the staff who is unlocked at payment time.
- Lockout: 5 wrong PINs → 5 min lock for that profile; 10 → 30 min; each further 5 doubles up to 1 h. Stored in `kv.pin_failures`.
- Forgotten PIN: an owner resets a staff PIN in Settings → Cashiers; a forgotten **owner** PIN is reset as in §3.

### 4.1 Manager override

When an action needs a permission the current user lacks (e.g. discount above their limit, refund, void, open drawer without sale), show the override dialog: "Manager PIN needed" with a profile list filtered to staff who have the permission. The approver's PIN is checked locally; the action proceeds under the **current** user's `staff_id`, and an `audit_log` row records `{ action: 'override', after_json: { permission, approved_by } }`.

## 5. Server-side enforcement

The till enforces permissions in the UI; the Worker re-checks the ones that matter, using the `staff_id` on the row and the server copy of `staff` **of the caller's tenant** (a `staff_id` that exists only in another tenant fails the composite foreign key):

| Op | Required |
|---|---|
| insert `refunds` | staff has `refund.create`, or an `audit_log` row `action = 'override'`, `entity = 'refunds'`, `entity_id = <refund id>`, `after_json.permission = 'refund.create'`, whose `approved_by` staff has the permission, is applied in the **same batch** (the refund op is applied only together with it) |
| insert `sale_voids` | `sale.void` (or override, same linking rule); a manager only when the sale's `business_date` equals the void's `business_date` |
| insert `sale_lines` with `below_cost = 1` | the sale's staff has `sale.below_cost`, or an override audit row for the sale (same linking rule) |
| insert `expenses` | `expense.create`; for a cashier: `method = 'cash'` and `amount ≤ 200000` (Rs 2,000) unless overridden |
| insert `supplier_returns` (and its lines, payment, ledger rows) | staff has `purchase.create` |
| upsert/delete `staff`, `branches`, `shop` | `updated_by` is an owner |
| delete `products`, `customers`, `suppliers` | `updated_by` has `catalog.delete` / `party.delete` |
| upsert `products.price` / `last_cost` | `updated_by` has `catalog.edit` (purchases set `last_cost` and need `purchase.create`) |

## 6. Permission matrix

Defaults by role; the owner can override per person via `staff.permissions_json` (Settings → Cashiers → person → Permissions).

| Permission key | Description | Owner | Manager | Cashier |
|---|---|:-:|:-:|:-:|
| `sale.create` | Sell, hold, quick sale | ✔ | ✔ | ✔ |
| `sale.discount` | Discounts up to `staff.max_discount_bp` of the bill (line + bill) | ✔ (100%) | ✔ (default 20%) | ✔ (default 5%) |
| `sale.udhaar` | Put a bill on udhaar | ✔ | ✔ | ✔ |
| `sale.below_cost` | Complete a sale with a below-cost line without override | ✔ | ✔ | ✘ |
| `sale.void` | Void / reissue a bill | ✔ | ✔ (same day only) | ✘ |
| `refund.create` | Refund whole/partial | ✔ | ✔ | ✘ |
| `drawer.open` | Open drawer without a sale (F9) | ✔ | ✔ | ✘ |
| `cash.move` | Pay-in / pay-out | ✔ | ✔ | ✘ |
| `dayclose.create` | Close the day for this device | ✔ | ✔ | ✔ |
| `dayclose.view_expected` | See expected cash before counting (blind count off) | ✔ | ✔ | ✘ |
| `payment.receive` | Receive udhaar payment | ✔ | ✔ | ✔ |
| `party.edit` | Create/edit customers and suppliers, credit limits | ✔ | ✔ | create only, no limit edit |
| `party.delete` | Delete customer/supplier (balance must be 0) | ✔ | ✘ | ✘ |
| `catalog.edit` | Create/edit products, prices, categories, import, bulk price update, generate barcodes, print barcode labels | ✔ | ✔ | ✘ |
| `catalog.delete` | Delete products | ✔ | ✘ | ✘ |
| `cost.view` | See cost, margin, profit | ✔ | ✔ | ✘ |
| `stock.adjust` | Stock adjustments and counts | ✔ | ✔ | ✘ |
| `purchase.create` | Record deliveries, pay suppliers, return to supplier, print barcode labels | ✔ | ✔ | ✘ |
| `expense.create` | Record expenses | ✔ | ✔ | ✔ (cash, ≤ Rs 2,000 each) |
| `report.view` | Reports, sales history beyond today | ✔ | ✔ | today only |
| `export.data` | CSV/PDF exports, backups | ✔ | ✔ | ✘ |
| `settings.shop` | Shop profile, receipt/tax, categories, branches | ✔ | ✘ | ✘ |
| `settings.staff` | Cashiers, PINs, permissions | ✔ | ✘ | ✘ |
| `devices.manage` | Shop admin on an admin device: enrolment codes, devices, unsynced-ops import, conflicts (§3) | ✔ | ✘ | ✘ |
| `settings.device` | Printer, scanner, display, language (this device) | ✔ | ✔ | display/language; Printer and Scanner read-only (status, Test print, retry failed prints) |

## 7. Audit log actions

`override`, `discount_over_limit`, `refund`, `void`, `supplier_return`, `reissue`, `drawer_open`, `price_change`, `cost_change`, `product_delete`, `party_delete`, `credit_limit_change`, `staff_change`, `pin_reset`, `day_close_difference` (when |difference| ≥ Rs 100), `stock_count`, `backup_restore`, `cache_rebuilt`, `sync_ops_discarded`, `device_enrol_code`, `device_change`, `device_revoke`, `ops_import`, `operator_export`, `operator_import`, `tenant_restore`.

Each row stores `before_json`/`after_json` with only the changed fields and belongs to one tenant. The shop owner sees that shop's log in Settings → Activity (filter by action, staff, date; CSV export).
