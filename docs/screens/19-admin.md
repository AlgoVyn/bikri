# 19 — Owner admin (`/admin`)

Full URL `https://algovyn.com/bikri/admin`. Protected by **Cloudflare Access** (email one-time PIN; only `operator@example.com` is allowed), see [05 §3](../05-auth-and-roles.md#3-owner-admin-via-cloudflare-access). Online only (not precached). API: [04 §3.7](../04-api.md#37-admin-endpoints-cloudflare-access). Simple, utilitarian layout using the same design tokens.

Devices page also has **Import unsynced ops** (only for revoked devices): choose the `bikri-unsynced-*.json` file a removed till exported → preview (op count, date range, totals of sales/payments in it) → `Import` → `POST /api/admin/import-ops` in chunks of 200 → result summary ([03 §8](../03-sync.md#8-device-revocation-and-data-loss-window)).

No Dukaan reference (Dukaan's equivalent is a vendor account page, which is excluded).

## Pages

| Page | Content | Actions |
|---|---|---|
| **Overview** | shop name, signed-in email, D1 size and daily row-write usage vs free-tier limits ([01 §8](../01-architecture.md#8-cloudflare-free-tier-budget)), last backup, devices online in last 24 h, open conflicts | — |
| **Enrol this browser** | explains it makes this browser a till | `Enrol` → `POST /api/admin/enrol-this-browser` → token stored → full navigation to `/bikri/` (router → `/setup` or PIN lock) |
| **Enrolment codes** | create code: device name, branch, role hint; shows 8-char code (groups of 4) + QR, countdown 15:00; list of unused codes | `Create code`, `Cancel code` |
| **Devices** | name, code (A, B…), branch, last seen, app version, pending ops reported, status | `Rename`, `Move branch`, `Revoke` (confirm: "Unsynced sales on that device will stay on it and can be exported there") |
| **Backups** | list of nightly R2 backups (date, size, tables, row counts) | `Download` (streamed through the Worker from R2). Note: on-demand backups are run from GitHub → Actions → `backup` → Run workflow |
| **Conflicts** | `sync_conflicts` rows: kind, table, row, fields, resolution, time; over-refund/void cases highlighted | `Acknowledge` (sets resolution `acknowledged`) |
| **Owner PIN reset** | pick owner profile, type new PIN twice; browser computes PBKDF2 and sends hash | `Reset` → `audit_log pin_reset` |

## Acceptance criteria

1. Visiting `/admin` without Access login redirects to the Cloudflare Access login; an email not in `OWNER_EMAILS` gets 403.
2. A created code enrols exactly one device within 15 minutes.
3. Revoking a device makes its next sync return `DEVICE_REVOKED` and shows the enrol screen there.
4. Backups list shows the last 30 nights; download returns a `.sql.gz` file.
5. `/api/sync/*` never accepts an Access JWT in place of a device token, and `/api/admin/*` never accepts a device token.
