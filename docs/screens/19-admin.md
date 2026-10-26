# 19 — Operator console (`/admin`)

Full URL `https://algovyn.com/bikri/admin`. For the **platform operator** only (Adnan), not for shop owners, who manage their own shop in [Settings → Devices](17-settings.md#devices-admin-devices-owner-only) on an admin device. Protected by **Cloudflare Access** (email one-time PIN; only `adnan@yaqoob.org` is allowed), see [05 §3.1](../05-auth-and-roles.md#31-platform-operator-via-cloudflare-access). Online only (not precached). It never opens or writes a shop's Dexie database. API: [04 §3.7](../04-api.md#37-operator-endpoints-cloudflare-access). Simple, utilitarian layout using the same design tokens. Tenancy model and lifecycle: [13](../13-multi-tenancy.md).

No Dukaan reference (Dukaan's equivalent is a vendor account page, which is excluded).

## Pages

| Page | Content | Actions |
|---|---|---|
| **Overview** | signed-in email; account-wide D1 size and today's rows written/read vs free-tier limits and vs the 70 % shop share ([13 §6](../13-multi-tenancy.md#6-free-tier-budget-per-shop)); last backup; tenants by status; tenants over 80 % of their budget; open conflicts per tenant | — |
| **Tenants** | table: display name, slug, status, devices, last seen, setup done, today's writes vs budget (bar) | `New shop`, open a tenant |
| **New shop** | display name, slug (`[a-z0-9-]{3,30}`, live `SLUG_TAKEN` check), owner email (reminder: add it to Cloudflare Email Routing destination addresses so the owner can verify it), daily write budget (default 7,000), note | `Create` → shows the **owner pairing code** (`XXXX-XXXX`, QR, link, 72 h countdown) with `Copy link` and a WhatsApp-ready text; the code is shown once |
| **Tenant → Summary** | status with reason and since, status history (from `tenant_status_change` rows), created, setup completed, shop name (from `shop`), owner email, budget, `poll_after_ms`, 7-day usage chart from `tenant_usage`, restore epoch, last restore, last owner server export, active support access | `Edit` (incl. owner email), `Make read-only` / `Suspend` / `Reactivate` (reason required, [13 §7.2](../13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)), `Support access…` / `End support access` ([13 §7.5](../13-multi-tenancy.md#75-operator-support-access-d-084)), `Issue owner pairing code` (cancels the previous one), `Export`, `Restore…`, `Delete…` |
| **Tenant → Devices** | that tenant's devices: name, code, branch, admin, kind (till / support), last seen, app version, pending ops, `read_only_seen_at`, status | `Revoke` (also the last admin device), `Issue code`, **Import unsynced ops** (revoked devices only: file → preview → `POST /api/admin/tenants/:id/import-ops` in chunks of 200; a file whose `tenant_id` differs is refused) |
| **Tenant → Owner PIN reset** | that tenant's owner profiles; type new PIN twice; the browser computes PBKDF2 and sends the hash; a reminder to confirm the owner's identity out of band first | `Reset` → `audit_log pin_reset` in that tenant |
| **Tenant → Export** | progress per table | builds `bikri-export-<slug>-<date>.zip` in the browser from `GET /api/admin/tenants/:id/export`; writes `operator_export` in the tenant's audit log |
| **Tenant → Restore** | step list: choose an export zip of **this** tenant (manifest `tenant.id` must match) → maintenance on → purge (progress) → import (progress) → restore point → maintenance off ([09 §3.4](../09-backups-and-ops.md#34-restore-one-tenant)) | each step resumable; `Abort` leaves the tenant in maintenance with a clear banner |
| **Tenant → Delete** | warning, last export date | type the slug to confirm → `status = 'deleting'`; progress of the cron deletion |
| **Backups** | nightly R2 backups (date, size, per-tenant row counts from the manifest) | `Download` (streamed through the Worker). On-demand backups: GitHub → Actions → `backup` → Run workflow |

Every tenant page shows the tenant's display name and slug in the header with a distinct colour band, so the operator always sees which shop they are acting on.

## Acceptance criteria

1. Visiting `/admin` without an Access login redirects to the Cloudflare Access login; an email not in `OWNER_EMAILS` gets 403.
2. `New shop` creates the tenant, its default branch and expense categories, and an owner pairing code that enrols exactly one device within 72 hours, into that tenant, as an admin device.
3. Revoking a device makes its next sync return `DEVICE_REVOKED` and shows the enrol screen there; devices of other tenants are unaffected.
4. Suspending a tenant makes its tills' sync show "paused" (`TENANT_SUSPENDED`) while other tenants keep syncing; reactivating resumes sync with nothing lost.
5. Export → Restore of a scratch tenant gives the same row counts, and another tenant's counts and sync are unchanged throughout (drill H14).
6. Backups list shows the last 30 nights; download returns a `.sql.gz` file.
7. `/api/sync/*` and `/api/shop/*` never accept an Access JWT in place of a device token, and `/api/admin/*` never accepts a device token.
8. Every operator action on a tenant writes an `audit_log` row in that tenant only.
9. `Make read-only` without a reason is impossible; with one, the shop's tills show the read-only banner after their next sync, sales made offline before that are applied, and the status history lists operator, reason and time.
10. `Support access…` (reason + duration) returns a single-use code; the shop shows the support banner until the time ends, the operator ends it, or the owner ends it; each start and end is in the shop's Activity.
