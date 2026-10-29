# 05 — Auth and roles

Bikri is multi-tenant ([13](13-multi-tenancy.md)): every till, staff member, PIN and permission belongs to exactly one **tenant** (shop). There are five layers:

1. **Device token** — proves a browser is an enrolled till **of one tenant**. Required for all till API calls; the Worker derives the tenant from it (`devices.token_hash` → `devices.tenant_id`).
2. **Staff PIN** — says which person of that shop is using the till. Checked on the device, works offline. Staff, roles and PINs are per tenant.
3. **Admin device** — a till with `devices.is_admin = 1` may also call the **shop-admin API** (`/api/shop/*`) for its own tenant: enrolment codes, devices, conflicts, unsynced-ops import, server export (§3).
4. **Owner email sign-in** — a one-time code sent to the shop owner's email gives a short **owner session** on that admin device; the shop-admin API needs it **in addition to** the admin device and the owner PIN (§3.2, D-082).
5. **Cloudflare Access** — protects the **platform operator console** (`https://algovyn.com/bikri/admin*`, `https://algovyn.com/bikri/api/admin/*`) with email one-time PIN. The only allowed email is **`adnan@yaqoob.org`** (D-022). The operator is not a staff member of any shop.

Paths in this doc are relative to the `/bikri` base path ([01 §1.1](01-architecture.md#11-url-layout-and-the-path-convention-used-in-these-docs)). The till paths (`/bikri/`, `/bikri/api/sync/*`, `/bikri/api/files/*`, `/bikri/api/me`, `/bikri/api/shop/*`) and the rest of `algovyn.com` are **not** behind Access, because Access login redirects would break offline service-worker requests.

## 0. Roles

| Role | Scope | Who | How they authenticate |
|---|---|---|---|
| **Platform operator** | the whole deployment | `adnan@yaqoob.org` | Cloudflare Access (email OTP) on `/admin*`; `OWNER_EMAILS` secret. Renamed in docs from "owner admin"; the secret keeps its name |
| **Owner** | one tenant | shop owner | device token + PIN; shop-admin actions only on an admin device, with an owner email sign-in (§3.2) |
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
| Cashier uses the shop-admin API (enrol extra devices, revoke tills) | Only admin devices may call `/api/shop/*`; the UI requires an owner PIN unlock on that device; every call writes an `audit_log` row. A cashier with technical skill and physical access to an **unlocked admin device's** browser could still call it (the PIN is checked only on the device): keep admin devices to the owner's own PC/phone. Closed by **owner email sign-in** (§3.2): `/api/shop/*` also needs an owner session that only someone who can read the owner's mailbox gets |
| Someone with the PC reads IndexedDB | **Not defended** (no encryption at rest). Use a Windows account password. Documented risk. This includes the device token and every staff `pin_hash`: a 4–6 digit PIN hashed with PBKDF2 can be brute-forced offline in minutes, so the PIN only stops casual use at the counter. The operator console (Cloudflare Access) does not depend on PINs. |
| Another page on `algovyn.com` reads Bikri's storage | Same origin as the website; mitigations in [01 §5.4](01-architecture.md#54-same-origin-as-the-website-storage-permissions-cookies-cors) (no third-party JS anywhere on `algovyn.com`). |
| Cross-site request forgery on the operator API (cookie-authenticated) | `sameOrigin` check on `/api/admin/*` ([01 §5](01-architecture.md#5-worker-and-hono)); till and shop-admin APIs use bearer tokens, not cookies. |
| A till claims another staff member's `staff_id` | Not defended server-side beyond "the staff row exists, is active and belongs to the same tenant" (PINs are checked only on the device); the audit trail records device + staff. Accepted for a shop's own trusted staff. |
| Brute force of a 4-digit PIN on the device | Lockout after 5 wrong tries for 5 minutes, doubling each time (max 1 h). PIN is a convenience lock, not encryption. |
| Brute force of enrolment codes | 8 chars from 30 symbols (≈ 6.6 × 10¹¹), 15-minute expiry (72 h for owner pairing codes), single use, WAF rate limit + per-IP counter. A code enrols into the tenant it was created for; a guessed code from another shop would join that shop, so codes are never shown in logs or URLs other than the enrol link |
| The operator reads shop data | Not prevented technically (the operator runs D1 and holds the backup key); stated to shop owners in the terms and privacy notes ([09 §6.1](09-backups-and-ops.md#61-terms-and-privacy-notes-for-shop-owners)). Operator exports, imports, status changes and support access are logged in that tenant's `audit_log` (`operator_export`, `operator_import`, `tenant_status_change`, `support_access_start` / `_end`), visible to the shop owner in Settings → Activity; support access also shows a banner on every till while it lasts ([13 §7.5](13-multi-tenancy.md#75-operator-support-access-d-084)) |
| Someone requests email codes to spam the owner or guess a code | The request names no address: a code only ever goes to the tenant's own `owner_email`, and only when asked from that tenant's admin device by an unlocked owner. Rate limits, 10-minute expiry, 5 tries per code and single use (§3.2) |

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

- Endpoints `/api/shop/*` ([04 §3.8](04-api.md#38-shop-admin-endpoints-admin-device)) require a valid device token **and** `devices.is_admin = 1`, the header `X-Bikri-Staff: <staff_id>` naming an active `owner` of the same tenant (the UI sends it only after an owner PIN unlock), **and** a valid owner session `X-Bikri-Owner-Session` for that device and owner (§3.2). Missing or wrong → `403 FORBIDDEN`; missing or expired session → `401 OWNER_SIGNIN_REQUIRED` (the UI then runs the email sign-in). Exceptions that need only the admin device and owner PIN: the email sign-in endpoints themselves and `POST /api/shop/support-access/end` (it only removes access).
- Features: create/cancel enrolment codes (admin or not), list/rename/move/revoke devices, make a device admin or not (at least one non-revoked admin device must remain), import a revoked device's unsynced ops, list and acknowledge sync conflicts, the server export ([13 §7.3](13-multi-tenancy.md#73-per-tenant-export-and-restore)), end operator support access. Every call writes an `audit_log` row (`device_enrol_code`, `device_change`, `device_revoke`, `ops_import`, `owner_export`, `support_access_end`), pulled to all tills like any other row.
- Forgotten **owner** PIN: another `owner` of the shop resets it in Settings → Cashiers; if there is none, the operator resets it from the console after confirming the owner's identity out of band (`POST /api/admin/tenants/:id/reset-owner-pin`).

## 3.1 Platform operator via Cloudflare Access

- Access application: self-hosted, hostname `algovyn.com`, destinations `bikri/admin`, `bikri/admin/*`, `bikri/api/admin`, `bikri/api/admin/*` (setup steps in [01 §7.1](01-architecture.md#71-one-time-setup-platform-operator)). Policy: Allow, Include → Emails → `adnan@yaqoob.org`. Identity: One-time PIN. Session duration 24 h. No other part of `algovyn.com` is behind Access.
- `OWNER_EMAILS` Worker secret = `adnan@yaqoob.org` (the operator list; name kept from M0). Adding an operator later means changing **both** the Access policy and this secret ([09](09-backups-and-ops.md)).
- Links from the till UI to the console must be **full page navigations** (`window.location.assign('/bikri/admin')`), never client-side router navigation, so the request reaches Cloudflare Access. When an admin API call returns `401`, or a redirect to `*.cloudflareaccess.com` (fetch with `redirect: 'manual'` gives an `opaqueredirect` response), the console reloads itself to start a new Access login.
- The console is a separate route tree in the same PWA (`/bikri/admin/*`), not precached by the service worker (always online). It never opens or writes a tenant Dexie database.
- Worker verification (`accessAuth` middleware): read `Cf-Access-Jwt-Assertion`; fetch JWKS from `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (cache 1 h in module scope); verify RS256 signature, `aud` contains `ACCESS_AUD`, `iss` = `https://${ACCESS_TEAM_DOMAIN}`, `exp` in the future, `email` in `OWNER_EMAILS`. Otherwise `401 UNAUTHENTICATED` / `403 FORBIDDEN`. Tenant-specific operator routes take the tenant from the path (`/api/admin/tenants/:id/…`) and check it exists.
- Server-originated rows (default branch at tenant creation, PIN reset audit, operator imports) use `device_id = 'server'` and `staff_id` = the tenant's owner staff row (or `'server'` before setup), always with that tenant's `tenant_id`.

Operator features (v1, [screens/19](screens/19-admin.md)): tenants (create with owner pairing code and owner email, edit budget/poll interval/owner email, make read-only, suspend, reactivate, delete — each status change with a reason), per-tenant devices (list, revoke, issue a code), per-tenant usage vs budget and account-wide usage, backups (list, download), per-tenant export, restore and unsynced-ops import, per-tenant owner PIN reset, operator support access (start, end), conflicts counts.

## 3.2 Owner email sign-in (D-082)

Owner's choice: **email sign-in** is the stronger sign-in for shop owners. It is added **on top of** the admin device and the owner PIN, not instead of them: the PIN still unlocks the till offline for everything local, and the email code is the extra step for the server-side shop-admin API (`/api/shop/*`), which is online anyway. Passkeys are not used.

**Why a one-time code and not a magic link.** The owner uses Bikri as an installed PWA; a link in an email opens in whatever browser the mail app picks, which has no device token, and mail scanners often open links before the person does, using up a single-use link. A 6-digit code is typed on the admin device that asked for it, so the session is bound to that device.

**Owner email.** `tenants.owner_email` (one per shop in v1, lowercase) is entered by the operator when creating the shop or later in the console (`PATCH /api/admin/tenants/:id`, audit `owner_email_change` in the shop). On the Cloudflare Free plan the Worker can only send to **verified destination addresses** ([13 §2](13-multi-tenancy.md#2-cloudflare-facts-the-decision-rests-on-checked-27-oct-2026)), so the operator also adds the address in the Cloudflare dashboard (Email Service → Email Routing → Destination addresses), and Cloudflare emails the owner a verification link that they click once. Owners can't change the address themselves in v1. Showing the address to the owner: masked (`a***@gmail.com`) on the sign-in screen.

**Sending.** Worker binding `send_email: [{ "name": "EMAIL", "allowed_sender_addresses": ["bikri@algovyn.com"] }]` (`algovyn.com` is already an Email Routing domain). From `Bikri <bikri@algovyn.com>`, subject "Your Bikri sign-in code", plain-text body in English and Urdu: the code, the shop name, the device name, "expires in 10 minutes", and "If you did not ask for this, ignore this email; nobody can sign in without the code." The code is not in the subject (lock-screen previews). Sends to verified addresses are free and do not count toward any Cloudflare email quota. If sending fails (address not verified, Cloudflare error) the API answers `503 EMAIL_UNAVAILABLE` and the till says "Email sign-in isn't working for this shop. Contact Algovyn."; a shop with no `owner_email` gets the distinct `503 OWNER_EMAIL_MISSING` and the till points to the operator console. The operator can do any device action from the console meanwhile.

**Flow.**
1. On an admin device, unlocked as an owner, the first shop-admin action shows "Confirm it's you" with the masked email → `POST /api/shop/owner-signin/start` (headers as above, no session yet). The server checks the limits below, creates an `owner_email_codes` row (6 digits from `crypto.getRandomValues` with rejection sampling; only `HMAC-SHA256(OWNER_CODE_KEY, tenant_id ‖ id ‖ code)` stored), sends the email, and returns `{ code_id, expires_at, email_hint }`.
2. The owner types the code → `POST /api/shop/owner-signin/verify { code_id, code }`. The server compares in constant time, counts the attempt, and on success marks the code used and returns `{ session, expires_at }`.
3. The session is a stateless token `base64url(payload).HMAC-SHA256(OWNER_SESSION_KEY, payload)` with `{ tenant_id, device_id, staff_id, exp }` (12 hours). It costs no D1 write per request; the Worker checks the signature, `exp`, that `tenant_id` and `device_id` equal the token's device, and that `staff_id` is still an active owner. The till keeps it **in memory only**: Lock, Switch user, auto-lock and reload drop it, and the next shop-admin action asks for a new code. Revoking the device or deactivating the owner ends it at once.

**Limits and abuse protection.**
- Code: 6 digits, expires after **10 minutes**, single use, at most **5 wrong tries** (then dead).
- Sending: one code per device per **60 seconds** (resend cooldown), at most **5 codes per shop per hour** and **20 per day** (counted from `owner_email_codes` by `(tenant_id, created_at)`); over the limit → `429 RATE_LIMITED` with `Retry-After`. Starting a new code kills the previous unused one.
- Per-IP: Workers Rate Limiting binding `OWNER_SIGNIN_LIMIT` (`simple: { limit: 10, period: 60 }`, key `ip:<CF-Connecting-IP>`) on both endpoints; approximate, a second line of defence.
- Only the shop's own owner can ask, only from the shop's own admin device, and the address is never in the request: nobody can make Bikri email an arbitrary address, and other shops' owners cannot be reached.
- After 3 dead codes in an hour the shop's sign-in pauses for 1 hour and the console flags the shop.
- Every successful sign-in writes `audit_log` `owner_signin` (staff, device) in the shop; failures are counted in Workers Logs (no codes, no addresses).
- Rows in `owner_email_codes` are deleted by the nightly cron 1 day after they expire.
- Secrets `OWNER_CODE_KEY` and `OWNER_SESSION_KEY` (32 random bytes each, `wrangler secret put`); rotating `OWNER_SESSION_KEY` signs every owner out.

**Testing.** Worker tests use a fake `EMAIL` binding that records messages; E2E journey 24 reads the code from it ([10 §5](10-testing.md#5-e2e-journeys-each-in-en-and-ur-desktop-1280800-and-phone-390844)). Isolation case I23.

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
| `devices.manage` | Shop admin on an admin device with owner email sign-in: enrolment codes, devices, unsynced-ops import, conflicts, server export (§3, §3.2) | ✔ | ✘ | ✘ |
| `settings.device` | Printer, scanner, display, language (this device) | ✔ | ✔ | display/language; Printer and Scanner read-only (status, Test print, retry failed prints) |

## 7. Audit log actions

`override`, `discount_over_limit`, `refund`, `void`, `supplier_return`, `reissue`, `drawer_open`, `price_change`, `cost_change`, `product_delete`, `party_delete`, `credit_limit_change`, `staff_change`, `pin_reset`, `day_close_difference` (when |difference| ≥ Rs 100), `stock_count`, `backup_restore`, `cache_rebuilt`, `sync_ops_discarded`, `device_enrol_code`, `device_change`, `device_revoke`, `ops_import`, `operator_export`, `operator_import`, `tenant_restore`, `tenant_status_change`, `owner_email_change`, `owner_signin`, `owner_export`, `support_access_start`, `support_access_end`.

Each row stores `before_json`/`after_json` with only the changed fields and belongs to one tenant. The shop owner sees that shop's log in Settings → Activity (filter by action, staff, date; CSV export).
