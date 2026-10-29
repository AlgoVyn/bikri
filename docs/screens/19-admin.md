# 19 — Operator console (`/admin`)

Full URL `https://algovyn.com/bikri/admin`. For the **platform operator** only (Adnan), not for shop owners, who manage their own shop in [Settings → Devices](17-settings.md#devices-admin-devices-owner-only) on an admin device. Protected by **Cloudflare Access** (email one-time PIN; only `adnan@yaqoob.org` is allowed), see [05 §3.1](../05-auth-and-roles.md#31-platform-operator-via-cloudflare-access). Online only (not precached). It never opens or writes a shop's Dexie database. API: [04 §3.7](../04-api.md#37-operator-endpoints-cloudflare-access). The console shares the shop app's component language: the same design tokens, Algovyn type scale, card surfaces, controls, status pills and icon set. Tenancy model and lifecycle: [13](../13-multi-tenancy.md).

No Dukaan reference (Dukaan's equivalent is a vendor account page, which is excluded).

## Layout

- **Shell:** follows the device theme selected in the shop app (`bikri.theme` in localStorage); a brand-navy rail on ≥ 1024 px with the Bikri mark, `Bikri` / `Operator console`, and Overview / Shops / Backups. The top bar carries the language switcher; on smaller screens the rail becomes a horizontal nav under the compact brand header. The content column is capped at 1280 px.
- **Headers:** every page starts with an icon tile, an `h1`, a one-line subtitle and its primary actions, matching the shop pages.
- **Overview:** four KPI cards (shops, active, devices, setup complete), then *Usage today* (database size and the write/read meters against the free-tier limits), *Shops by status*, and a *Needs attention* panel for the last backup, shops over 80 % of their write budget and open sync conflicts. One `GET /admin/usage` request supplies the conflict counts grouped by tenant.
- **Shops:** a search box (name or slug), a status filter, a result count and 20-row pagination. Each row shows the name and slug, a status pill, devices, last seen, setup state and the daily write meter. Below 768 px the rows become summary cards; on tablets the table scrolls horizontally.
- **New shop:** a two-column sheet — shop details on the start side, a numbered *What happens next* card on the end side. After creation the page shows the one-time pairing panel with Copy link and WhatsApp, and an `Open shop` action.
- **Tenant:** a back link, then a surface header with a tenant-specific colour stripe and icon tile, the name and slug, a status pill and owner/setup metadata. Pill tabs open Summary, Devices, Owner PIN, Export, Restore and Delete. Summary shows a status card, a shop-profile definition list, the 7-day write chart, a status timeline and grouped operations; an active support session gets its own info banner.
- **Devices:** an issue-code card, a compact device table (device/code/branch, kind, last seen/version, pending, read-only seen, status, revoke) and a separate unsynced-ops import card.
- **Backups:** a page header, a short explanation of the nightly workflow, three summary cards (latest, count, total size) and a table of the last 30 backups. Per-shop row counts expand from a summary line.
- **Colour and hierarchy:** status pills use the semantic success/warning/danger/muted token pairs; destructive actions sit in a clearly bounded danger zone; apps never use raw hex colours.

## Pages

| Page | Content | Actions |
|---|---|---|
| **Overview** | signed-in email; KPI cards for shops/active/devices/setup; account-wide D1 size and today's rows written/read vs free-tier limits and vs the 70 % shop share ([13 §6](../13-multi-tenancy.md#6-free-tier-budget-per-shop)); shops by status; a *Needs attention* panel with the last backup, tenants over 80 % of their budget and open conflicts per tenant | `Refresh` |
| **Tenants** | searchable/filterable table: display name, slug, status pill, devices, last seen, setup done, today's writes vs budget (meter); 20 rows per page | `New shop`, open a tenant |
| **New shop** | display name, slug (`[a-z0-9-]{3,30}`, live `SLUG_TAKEN` check), owner email (reminder: add it to Cloudflare Email Routing destination addresses so the owner can verify it), daily write budget (default 18,000), note | `Create` → shows the **owner pairing code** (`XXXX-XXXX`, QR, link, 72 h countdown) with `Copy link` and a WhatsApp-ready text; the code is shown once |
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
