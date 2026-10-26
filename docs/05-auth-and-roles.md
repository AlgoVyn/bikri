# 05 — Auth and roles

Bikri has three layers:

1. **Device token** — proves a browser is an enrolled till. Required for all till API calls.
2. **Staff PIN** — says which person is using the till. Checked on the device, works offline.
3. **Cloudflare Access** — protects the owner admin (`https://algovyn.com/bikri/admin*`, `https://algovyn.com/bikri/api/admin/*`) with email one-time PIN. The only allowed email is **`adnan@yaqoob.org`**.

Paths in this doc are relative to the `/bikri` base path ([01 §1.1](01-architecture.md#11-url-layout-and-the-path-convention-used-in-these-docs)). The till paths (`/bikri/`, `/bikri/api/sync/*`, `/bikri/api/files/*`, `/bikri/api/me`) and the rest of `algovyn.com` are **not** behind Access, because Access login redirects would break offline service-worker requests.

## 1. Threat model (what we defend against)

| Threat | Mitigation |
|---|---|
| Stranger calls the API | Device token required; 32 random bytes; only hash stored |
| Stolen/lost till | Owner revokes device in admin; token stops working immediately |
| Cashier gives unauthorised discounts/refunds | Role permissions on device and server; manager PIN override; audit log |
| Cashier sees cost/margin | `cost.view` permission; cost hidden in UI |
| Someone with the PC reads IndexedDB | **Not defended** (no encryption at rest). Use a Windows account password. Documented risk. This includes the device token and every staff `pin_hash`: a 4–6 digit PIN hashed with PBKDF2 can be brute-forced offline in minutes, so the PIN only stops casual use at the counter. Admin (Cloudflare Access) does not depend on PINs. |
| Another page on `algovyn.com` reads Bikri's storage | Same origin as the website; mitigations in [01 §5.4](01-architecture.md#54-same-origin-as-the-website-storage-permissions-cookies-cors) (no third-party JS anywhere on `algovyn.com`). |
| Cross-site request forgery on admin API (cookie-authenticated) | `sameOrigin` check on non-GET `/api/admin/*` ([01 §5](01-architecture.md#5-worker-and-hono)); till API uses bearer tokens, not cookies. |
| A till claims another staff member's `staff_id` | Not defended server-side (PINs are checked only on the device); the audit trail records device + staff. Accepted for a single trusted shop. |
| Brute force of a 4-digit PIN on the device | Lockout after 5 wrong tries for 5 minutes, doubling each time (max 1 h). PIN is a convenience lock, not encryption. |
| Brute force of enrolment codes | 8 chars base32 (~10^12), 15-minute expiry, single use, WAF rate limit |

## 2. Device enrolment

Two ways, both owner-initiated (REQ-B05: no vendor account or activation):

**A. Enrol this browser (owner at the till).**
1. Owner opens `https://algovyn.com/bikri/admin` on the till. Cloudflare Access asks for email → one-time PIN by email.
2. Admin page → "Enrol this browser as a till" → enter device name (default "Counter 1") and branch.
3. Admin calls `POST /api/admin/devices/enrol-this-browser`; the response token is saved in IndexedDB `kv.device_token`, and `kv.device` gets the device info.
4. Browser navigates to `/`. If `shop_setup_completed = false`, the setup wizard starts ([screens/01](screens/01-setup-wizard.md)); otherwise the initial sync (snapshot, [03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot)) runs, then the PIN lock.

**B. Enrolment code (any browser).**
1. Owner in admin (on any device) → "Add a till" → name + branch → shows code `K7Q2-M9XD` and a QR of `https://algovyn.com/bikri/enrol?code=K7Q2M9XD`, valid 15 minutes.
2. On the new device, open `algovyn.com/bikri` → the un-enrolled screen ([screens/02](screens/02-enrol.md)) → type or scan the code → `POST /api/devices/enrol`.

Device codes are assigned per branch in order A, B, … Z, AA, AB … and never reused, even after revocation.

## 3. Owner admin via Cloudflare Access

- Access application: self-hosted, hostname `algovyn.com`, destinations `bikri/admin`, `bikri/admin/*`, `bikri/api/admin`, `bikri/api/admin/*` (setup steps in [01 §7.1](01-architecture.md#71-one-time-setup-owner)). Policy: Allow, Include → Emails → `adnan@yaqoob.org`. Identity: One-time PIN. Session duration 24 h. No other part of `algovyn.com` is behind Access.
- `OWNER_EMAILS` Worker secret = `adnan@yaqoob.org`. Adding an admin later means changing **both** the Access policy and this secret ([09](09-backups-and-ops.md)).
- Links from the till UI to admin must be **full page navigations** (`window.location.assign('/bikri/admin')`), never client-side router navigation, so the request reaches Cloudflare Access. When an admin API call returns `401`, or a redirect to `*.cloudflareaccess.com` (fetch with `redirect: 'manual'` gives an `opaqueredirect` response), the admin page reloads itself to start a new Access login.
- The admin UI is a separate route tree in the same PWA (`/bikri/admin/*`), not precached by the service worker (always online).
- Worker verification (`accessAuth` middleware): read `Cf-Access-Jwt-Assertion`; fetch JWKS from `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (cache 1 h in module scope); verify RS256 signature, `aud` contains `ACCESS_AUD`, `iss` = `https://${ACCESS_TEAM_DOMAIN}`, `exp` in the future, `email` in `OWNER_EMAILS`. Otherwise `401 UNAUTHENTICATED` / `403 FORBIDDEN`.
- Server-originated rows (default branch, PIN reset audit) use `device_id = 'server'` and `staff_id` = the owner staff row (or `'server'` before setup).

Admin features (v1): enrol this browser, create enrolment code, list/rename/move/revoke devices, list and download backups, view sync conflicts, reset owner PIN.

## 4. Staff PINs and session

- PIN: 4 digits by default (owner can allow 4–6 per person). Stored as PBKDF2-SHA256, 150,000 iterations, 16-byte random salt, 32-byte output, base64 (`staff.pin_hash`, `pin_salt`, `pin_iterations`). Hashing happens in the browser with WebCrypto.
- Weak PINs rejected at creation: `0000`, `1111`…`9999`, `1234`, `4321`, `1212`, the year `19xx/20xx` patterns, and any PIN already used by another active staff member on this shop.
- Unlock: pick profile chip → type PIN → compare hash locally. On success set `session = { staff_id, role, unlocked_at }` in memory (not persisted).
- Auto-lock: after 10 minutes without input (configurable 2–60, or "never" for owner), and on `Ctrl+L` / rail avatar → Lock.
- Switching cashier keeps carts and held bills; new lines and the eventual sale record the staff who is unlocked at payment time.
- Lockout: 5 wrong PINs → 5 min lock for that profile; 10 → 30 min; each further 5 doubles up to 1 h. Stored in `kv.pin_failures`.
- Forgotten PIN: owner resets a staff PIN in Settings → Cashiers; forgotten **owner** PIN is reset from admin (`POST /api/admin/reset-owner-pin`), which requires Access login.

### 4.1 Manager override

When an action needs a permission the current user lacks (e.g. discount above their limit, refund, void, open drawer without sale), show the override dialog: "Manager PIN needed" with a profile list filtered to staff who have the permission. The approver's PIN is checked locally; the action proceeds under the **current** user's `staff_id`, and an `audit_log` row records `{ action: 'override', after_json: { permission, approved_by } }`.

## 5. Server-side enforcement

The till enforces permissions in the UI; the Worker re-checks the ones that matter, using the `staff_id` on the row and the server copy of `staff`:

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
| `settings.device` | Printer, scanner, display, language (this device) | ✔ | ✔ | display/language; Printer and Scanner read-only (status, Test print, retry failed prints) |

## 7. Audit log actions

`override`, `discount_over_limit`, `refund`, `void`, `supplier_return`, `reissue`, `drawer_open`, `price_change`, `cost_change`, `product_delete`, `party_delete`, `credit_limit_change`, `staff_change`, `pin_reset`, `day_close_difference` (when |difference| ≥ Rs 100), `stock_count`, `backup_restore`, `cache_rebuilt`, `sync_ops_discarded`.

Each row stores `before_json`/`after_json` with only the changed fields. Owner sees the log in Settings → Activity (filter by action, staff, date; CSV export).
