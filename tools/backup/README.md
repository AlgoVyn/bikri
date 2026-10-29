# Backups

Nightly whole-database backup for [docs/09 §2](../../docs/09-backups-and-ops.md#2-nightly-backup-workflow-githubworkflowsbackupyml).

| File | Purpose |
|---|---|
| `export.mjs` | `wrangler d1 export`, sanity check, per-tenant row counts and `bikri-YYYY-MM-DD.manifest.json` |
| `files.mjs` | Weekly listing/download of every `bikri-files` object + sha256 manifest (docs/09 §2.1) |
| `cloudflare.mjs` | Shared R2 API helpers (list, download, delete) |
| `retention.mjs` | R2 retention: 30 daily + one backup per month (the earliest when the 1st is missing) |
| `tenant-extract.mjs` | One tenant out of a scratch `bikri-restore` DB → `bikri-export` zip (09 §3.4) |
| `zip.mjs` | Dependency-free STORE zip writer for the extract |
| `tables.mjs` | Tenant tables counted in the manifest (checked against `packages/db/src/tables.ts`) |

The nightly workflow is `.github/workflows/backup.yml`; it runs at 02:30 Asia/Karachi (21:30 UTC) and on demand. It needs the repository secrets `CLOUDFLARE_API_TOKEN` (D1 + R2 edit), `CLOUDFLARE_ACCOUNT_ID` and `BACKUP_AGE_RECIPIENT` (the operator's `age` public key). The plain dump goes only to the private `bikri-backups` R2 bucket; the GitHub artifact is always `age`-encrypted and kept for 90 days.

`files-backup.yml` runs weekly (Sunday 22:45 UTC = Monday 03:45 Asia/Karachi) and copies every object under `t/` in `bikri-files` (shop logos, product photos). It uses the same three secrets; the token needs R2 read on `bikri-files`. The runner writes `files/` plus `files-YYYY-MM-DD.manifest.json`, tars and `age`-encrypts it, and uploads `files-YYYY-MM-DD.tar.gz.age` for 90 days. Logs contain counts only, never keys or tenant ids.

Local smoke test (uses the local D1 from `wrangler dev`):

```sh
node tools/backup/export.mjs --local --out-dir /tmp/bikri-backup --date 2026-10-28
```

Copy the files bucket locally (useful before a restore drill):

```sh
node tools/backup/files.mjs --out-dir /tmp/bikri-files --date 2026-11-01
```

Restore one tenant from a nightly dump loaded into `bikri-restore`:

```sh
node tools/backup/tenant-extract.mjs --db bikri-restore --tenant <tenant_id> --backup-date YYYY-MM-DD --out export.zip
```

Restore procedure: [docs/09 §3.2](../../docs/09-backups-and-ops.md#32-restore-a-nightly-backup-to-a-new-database) (whole DB) and [§3.4](../../docs/09-backups-and-ops.md#34-restore-one-tenant) (one shop).
