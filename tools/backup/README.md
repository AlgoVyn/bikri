# Backups

Nightly whole-database backup for [docs/09 §2](../../docs/09-backups-and-ops.md#2-nightly-backup-workflow-githubworkflowsbackupyml).

| File | Purpose |
|---|---|
| `export.mjs` | `wrangler d1 export`, sanity check, per-tenant row counts and `bikri-YYYY-MM-DD.manifest.json` |
| `retention.mjs` | R2 retention: 30 daily + the 1st of 12 months |
| `tables.mjs` | Tenant tables counted in the manifest (checked against `packages/db/src/tables.ts`) |

The workflow is `.github/workflows/backup.yml`; it runs at 02:30 Asia/Karachi (21:30 UTC) and on demand. It needs the repository secrets `CLOUDFLARE_API_TOKEN` (D1 + R2 edit), `CLOUDFLARE_ACCOUNT_ID` and `BACKUP_AGE_RECIPIENT` (the operator's `age` public key). The plain dump goes only to the private `bikri-backups` R2 bucket; the GitHub artifact is always `age`-encrypted and kept for 90 days.

Local smoke test (uses the local D1 from `wrangler dev`):

```sh
node tools/backup/export.mjs --local --out-dir /tmp/bikri-backup --date 2026-10-28
```

Restore procedure: [docs/09 §3.2](../../docs/09-backups-and-ops.md#32-restore-a-nightly-backup-to-a-new-database).
