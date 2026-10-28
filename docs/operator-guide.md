# Operator guide

How to run the Bikri deployment: one Cloudflare Worker at `https://algovyn.com/bikri/`, one shared D1 database, one R2 bucket for shop files and one private R2 bucket for backups. Every shop's rows carry a `tenant_id`; only the Worker decides that id from a device token or an operator session.

Read [09 — Backups and ops](09-backups-and-ops.md) and [13 — Multi-tenancy](13-multi-tenancy.md) before changing production data.

## 1. Prerequisites

- Cloudflare account that owns the `algovyn.com` zone, Workers Free (or Paid), D1 and R2 enabled.
- GitHub repository `AlgoVyn/bikri` with Actions enabled.
- Node 24, pnpm 12 and `wrangler` 4 locally.
- An `age` key pair generated once, offline: `age-keygen -o bikri-backup.key`. Keep the private key offline (printed + password manager); only the public `age1…` recipient goes into GitHub.

## 2. One-time Cloudflare setup

Run these from `apps/api/`:

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler d1 create bikri
pnpm exec wrangler r2 bucket create bikri-files
pnpm exec wrangler r2 bucket create bikri-backups
```

1. Put the printed D1 `database_id` into `apps/api/wrangler.jsonc` (`d1_databases[0].database_id`).
2. Confirm the zone is proxied and that **no Custom Domain** is added for `algovyn.com`; the Worker uses the two path routes in `wrangler.jsonc`.
3. Zero Trust → Access → Applications → **Add self-hosted**:
   - name `Bikri admin`;
   - paths `algovyn.com/bikri/admin`, `/bikri/admin/*`, `/bikri/api/admin`, `/bikri/api/admin/*` (all four);
   - policy **Allow**, Include → Emails → `adnan@yaqoob.org`, login method One-time PIN, session 24 h.
   Copy the application **AUD** tag.
4. Email Routing is already active for `algovyn.com`. Verify every shop owner's address under **Email Service → Email Routing → Destination addresses**; the owner clicks Cloudflare's verification email once. `bikri@algovyn.com` is the sender.
5. Set Worker secrets (each command prompts for the value):
   ```sh
   pnpm exec wrangler secret put ACCESS_AUD
   pnpm exec wrangler secret put OWNER_EMAILS       # adnan@yaqoob.org
   pnpm exec wrangler secret put OWNER_CODE_KEY     # openssl rand -base64 32
   pnpm exec wrangler secret put OWNER_SESSION_KEY  # openssl rand -base64 32
   ```
6. GitHub → Settings → Secrets and variables → Actions:
   - secrets `CLOUDFLARE_API_TOKEN` (Workers, D1, R2 edit; also needs R2 object list/delete for retention), `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_AGE_RECIPIENT` (the `age1…` public key);
   - variable `DEPLOY_ENABLED=true`;
   - branch protection: require the `ci` check on `main`.
7. Apply migrations and deploy once:
   ```sh
   pnpm exec wrangler d1 migrations list bikri --remote
   pnpm exec wrangler d1 migrations apply bikri --remote
   cd ../.. && pnpm build
   cd apps/api && pnpm exec wrangler deploy
   ```
   Or merge to `main` and let `deploy.yml` do it.

## 3. Create the first shop

1. Open `https://algovyn.com/bikri/admin` (Cloudflare Access prompts for the operator email code).
2. **Tenants → New**: display name, slug (`a-z`, digits, `-`, 3–30), owner email, daily write budget (default 18,000 rows; a reference shop needs this).
3. Copy the owner pairing code/link once and send it to the owner. The plain code is never shown again.
4. The owner opens the link on the first till, enters their name and chooses the owner PIN. The setup wizard creates the shop, branch, tax and receipt settings.
5. In the console, the shop shows its devices and sync status. Rename or revoke devices from **Devices**.
6. To add tills or staff: owner on an admin device → **Settings → Devices** (issue code) and **Settings → Cashiers** (staff + PIN). The operator can also issue an owner pairing code from the console.

Target for a second shop: under 15 minutes from the console's New tenant button.

## 4. Every-day console actions

| Task | Where | Notes |
|---|---|---|
| Make a shop read-only | Tenant → **Make read-only** | Reason required; audited in the shop. Owner can still view and export. |
| Suspend / reactivate | Tenant → **Suspend** / **Reactivate** | Suspension blocks all server access; tills keep selling offline. |
| Support access | Tenant → **Support access** | Reason + 1–24 h. Join with the code in a **separate browser profile**; the device is view-only and expires automatically. The owner can end it. |
| Export one shop | Tenant → **Export** | Browser-built `bikri-export` zip from the server state; audited. |
| Restore one shop | Tenant → **Restore** | Maintenance on → purge → import (≤ 500 rows/call) → restore epoch → maintenance off. |
| Delete a shop | Tenant → **Delete** | Type the slug. Devices stop at once; the cron removes rows and `t/<tenant>/` files; the tenant row stays as a tombstone. Offer an export first. |
| Owner email change | Tenant → **Edit** | Also add/verify the address in Cloudflare Email Routing. |
| Owner PIN reset | Tenant → **Reset owner PIN** | The console hashes the new PIN in the browser; the plain PIN never reaches the Worker. |
| Budgets | Tenant → daily write budget | Keep the sum of active shops ≤ 70,000 rows on Free: four reference shops at 18,000 each. Ten shops need Workers Paid or lower volume. |

Status changes, exports, imports, restores and support access write an audit row **inside that shop**, visible to the owner in Settings → Activity; status changes and support access include the reason.

## 5. Backups

- `.github/workflows/backup.yml` runs daily at **02:30 Asia/Karachi** (21:30 UTC) and on demand.
- It exports D1, writes `d1/YYYY-MM-DD.manifest.json` with per-shop counts, uploads both to the private `bikri-backups` bucket, keeps an `age`-encrypted copy as a 90-day GitHub artifact, and prunes R2 to 30 daily + 12 monthly backups.
- The first run must be after this workflow exists on `main`; use **Actions → backup → Run workflow**. A same-day rerun is refused unless you tick `overwrite`, so a failed upload cannot silently replace a good pair.
- Check the run summary and the artifact. Then do the restore drill:
  1. `pnpm exec wrangler d1 create bikri-restore`
  2. download the `.sql.gz`, `gunzip`, `wrangler d1 execute bikri-restore --remote --file=...`
  3. compare every table's count with the manifest;
  4. delete `bikri-restore`.
- Whole-database Time Travel (§3.1 of doc 09) is only for deployment-wide disasters: set `MAINTENANCE=1`, restore, set a new `restore_epoch`/`restore_point_at` for every tenant, then unset it.
- Per-shop restore uses the console, not Time Travel. To extract one shop from a nightly backup loaded into `bikri-restore`:
  ```sh
  node tools/backup/tenant-extract.mjs --db bikri-restore --tenant <tenant_id> --backup-date YYYY-MM-DD --out export.zip
  ```

## 6. Monitoring and limits

- `GET /bikri/api/health` returns `{ ok, db, schema_version }`.
- Console Overview shows D1 size vs 500 MB, rows written/read vs 100k/5M per day, per-shop budget use, last backup age, tenant statuses.
- Free-plan production limits and the reference-shop measurement are in [13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop). The measured shop-year is **153 MB**, so start a new shard around 450 MB per DB.
- `wrangler tail` shows JSON request logs; never log tokens, PINs, codes, phone numbers or customer names.

## 7. Secrets and rotation

| Secret | Rotate when | Effect |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | yearly or on leak | Deploy/backup fail until updated. |
| `OWNER_SESSION_KEY` | on leak | Signs every owner out. |
| `OWNER_CODE_KEY` | on leak | Unused email codes stop working. |
| `ACCESS_AUD` | Access app recreated | Admin console refuses every request until updated. |
| `BACKUP_AGE_RECIPIENT` | age key rotated | Old backups stay decryptable with the old private key; new runs use the new key. |

Never put secret values in the repo, a PR, a screenshot or a support message.

## 8. Go-live checklist

Before the first real sale, complete [09 §7](09-backups-and-ops.md#7-go-live-checklist): website check clean, CSP/HSTS headers present, Access restricted, nightly backup + H11 drill passed, hardware H1–H14 recorded, isolation suite green, and a two-shop production check.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| `503 MAINTENANCE` on all shops | Worker var `MAINTENANCE=1` is still set; unset it. |
| One shop's pushes get `403 TENANT_READ_ONLY` | Tenant status read-only; reactivate with a reason. Ops made before the till learned are kept. |
| Owner cannot sign in by email | Address verified in Email Routing? `OWNER_CODE_KEY` set? Check the 3-dead-code pause and resend limits. |
| A till is lost/stolen | Console → Devices → Revoke (or owner Settings → Devices). Its unsynced ops can be exported first if the device still runs. |
| Backup run fails on `age` | `BACKUP_AGE_RECIPIENT` missing or not an `age1…` key. |
| Backup artifacts can be downloaded by other GitHub users | Expected on a public repo; artifacts are always `age`-encrypted. Never upload the plain dump. |
