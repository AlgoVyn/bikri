# 13 — Multi-tenancy

Bikri is **multi-tenant** (decision [D-064](decisions.md), superseding D-001). One deployment at `https://algovyn.com/bikri/` serves several independent shops (**tenants**), run by one **platform operator** (Adnan, `adnan@yaqoob.org`). Each tenant has its own staff, branches, tills, products, stock, sales, udhaar, suppliers, expenses, settings, receipts and files, and **must never see or change another tenant's data**.

This doc holds the tenancy model, the facts it is based on, the per-shop free-tier budget, the tenant lifecycle (onboarding, suspension, export, restore, deletion), the migration plan from the single-shop M0 code, and the questions only the owner can answer. The other docs apply it: schema [02](02-data-model.md), sync [03](03-sync.md), API [04](04-api.md), auth [05](05-auth-and-roles.md), backups [09](09-backups-and-ops.md), tests [10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory), roadmap [11](11-roadmap.md). Decisions: D-064–D-074 in the [decisions log](decisions.md).

## 1. Terms

| Term | Meaning |
|---|---|
| **Tenant** | One business using Bikri: its own `shop` row, branches, devices, staff and every business record. Row in `tenants`; id `tenant_id` (ULID). "Shop" in the UI. |
| **Platform operator** | The person who runs the deployment (v1: only `adnan@yaqoob.org`). Creates, suspends and deletes tenants, sees usage, holds the backup key. Not a staff member of any shop. |
| **Shop owner** | The `owner`-role staff member of one tenant. Manages that shop only. |
| **Admin device** | A till with `devices.is_admin = 1`, allowed to call the shop-admin API (create enrolment codes, manage devices) for its own tenant ([05 §3](05-auth-and-roles.md#3-shop-admin-on-admin-devices)). |
| **Shard** | A D1 database that holds tenant data. v1 has one shard, binding `DB`. `tenants.db_shard` names the binding a tenant lives in (§4). |

## 2. Cloudflare facts the decision rests on (checked 27 Oct 2026)

| Fact | Value | Source |
|---|---|---|
| D1 databases per account | **10 on Free** (50,000 on Workers Paid, raisable) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 maximum database size | **500 MB on Free** (10 GB Paid, cannot be raised) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 storage per account | **5 GB on Free** (1 TB Paid) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 rows read | **5,000,000 / day on Free**, reset 00:00 UTC, **per account** (all databases together) | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 rows written | **100,000 / day on Free**, per account; indexes add written rows; deletes count as writes | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| When the daily D1 limit is hit | queries fail with errors until 00:00 UTC | [D1 pricing FAQ](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 queries per Worker invocation | **50 on Free**; a `db.batch()` counts as one | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Bindings per Worker script | about 5,000 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Time Travel | 7 days on Free; restores **the whole database in place** | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) |
| Reaching a D1 database from a Worker | only through a **binding declared in the Worker config** (deploy time). The bindings list has no dynamic D1 binding. Bindings "provide better performance and less restrictions … than the REST APIs which are intended for non-Workers applications" | [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/) |
| D1 REST API | "primarily interacts with the control plane" (create/manage databases); Wrangler uses it | [Query D1](https://developers.cloudflare.com/d1/best-practices/query-d1/) |
| Cloudflare API rate limit | **1,200 requests / 5 minutes per user or account token**, cumulative across dashboard, keys and tokens | [API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) |
| Workers requests | **100,000 / day on Free**, per account; over the limit a route fails open or shows error 1027 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers CPU | 10 ms per request on Free | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers subrequests | 50 per request on Free (1,000 to Cloudflare services) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Cron Triggers | 5 per account on Free | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| R2 free tier | 10 GB-month storage, 1 M Class A, 10 M Class B operations **per month**; deletes free; no egress fees | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |

Consequences: the daily D1 row limits and the Workers request limit are **per account**, so they are shared by every tenant (and by the other Algovyn Workers such as SmartGrind and MarkSocial) whichever database layout is used. Only storage (500 MB) is per database.

## 3. Tenancy model (D-064)

### 3.1 Options considered

| | (a) One shared D1, `tenant_id` on every tenant row | (b) One D1 per tenant |
|---|---|---|
| Free-tier fit | 1 database. 500 MB shared by all shops | 1 of the **10 databases per account** per shop. The account also holds SmartGrind/MarkSocial databases, `bikri-preview` and the `bikri-restore` scratch DB, so only a handful of shops fit |
| Adding a shop | `INSERT INTO tenants` from the operator console, no deploy | `wrangler d1 create`, add a binding, redeploy (no dynamic D1 bindings), or call D1 through the REST API from the Worker: control-plane path, the 1,200 req / 5 min token limit shared with deploys and backups, and a powerful API token stored in the Worker |
| Daily row limits | per account either way, so a per-tenant budget is needed in both | same |
| Migrations, backups, prune | once | N times; each nightly export blocks its DB; the prune cron must stay within 50 queries per invocation across N DBs |
| Isolation | logical: composite keys, composite foreign keys, a tenant-scoped query layer and a mandatory test suite | physical |
| Restore one shop | logical (export, purge, re-import; §7) | Time Travel per shop |
| Storage ceiling | 500 MB for all shops on Free; 10 GB on Paid | 500 MB per shop |

### 3.2 Decision

**(a) one shared D1 database with `tenant_id` on every tenant-scoped row, shard-ready.**

- Every tenant-scoped table has `tenant_id TEXT NOT NULL`, a **composite primary key `(tenant_id, id)`**, and **composite foreign keys** `(tenant_id, x_id) → parent(tenant_id, id)`, so SQLite itself refuses a row that points at another tenant's row. Every uniqueness rule is per tenant: `(tenant_id, sku)`, `(tenant_id, barcode)`, `(tenant_id, bill_prefix)`, `(tenant_id, invoice_no)`, `(tenant_id, code)`, `(tenant_id, branch_id, device_code)`. Every index starts with `tenant_id`, so a query for one shop never scans another shop's rows (reads are billed by rows scanned).
- `tenant_id` is **never sent by a till and never trusted from a request**. The Worker derives it from the device token (or, for the operator console, from the URL after Access authentication) and binds it into every statement through one query layer (`apps/api/src/db/tenantDb.ts`, §5). Rows pulled by tills do not contain `tenant_id`.
- Shard-ready: `tenants.db_shard` names the D1 binding that holds the tenant's data (v1: always `DB`). All API code gets its database through `tenantDb(env, tenant)`, never `env.DB` directly. When the first shard nears 70 % of its size limit, or on moving to Workers Paid, the operator adds a binding (`DB_2`, …, one deploy) and moves tenants (§4). The 10-database Free limit still caps shards, but each shard holds many shops.

Why: at Bikri's size (1–2 tills and ~150 bills a day per shop) the binding constraint is the **account-wide** daily row and request limits, which (b) does not relieve; (b) spends one of 10 databases and a redeploy per shop, or puts the D1 REST API (control plane, 1,200 requests per 5 minutes) in the selling path. (a) costs nothing per shop and keeps one migration, one backup and one prune. Its weak point, logical rather than physical isolation, is covered by composite keys, a single tenant-scoped data layer and the mandatory isolation suite ([10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory)). Its other weak point, the 500 MB Free ceiling shared by all shops, is covered by the shard path and by Workers Paid (10 GB per database) when more shops join (§6).

## 4. Shards (later, not built in v1)

- The **primary** database (binding `DB`) always holds the platform tables (`tenants`, `tenant_usage`, `expense_category_templates`, `meta`) and, in v1, every tenant's data.
- A shard database holds only tenant-scoped tables (same `0001_init.sql`, platform tables unused). `wrangler.jsonc` lists every shard binding; migrations run on each (`wrangler d1 migrations apply <name> --remote` per shard in `deploy.yml`).
- Moving a tenant between shards is a tenant restore (§7.3): maintenance → export from the old shard → import into the new → set `db_shard` → new `restore_epoch`. `change_log.seq` is per database, so tills snapshot after the move (the new epoch triggers restore recovery, [03 §4.2](03-sync.md#42-pull--get-apisyncpullsinceseqlimit500)).
- One database per tenant stays possible later (Workers Paid: 50,000 databases, ~5,000 bindings per Worker) as the extreme case of sharding; it would be a new decision.

## 5. Tenant scoping rules (for implementers)

1. The request context has exactly one tenant: `c.var.tenant` from `deviceAuth` (device token → `devices.tenant_id`) or from the operator route parameter after `accessAuth`. There is no other way to get a tenant id.
2. All SQL against tenant tables goes through `tenantDb(env, tenant)`, whose helpers (`select`, `insert`, `upsert`, `batch`) always bind `tenant_id` as `?1` and refuse a statement whose SQL text lacks `tenant_id = ?1` (tenant tables) — checked at runtime in tests and by a unit test that runs every exported statement builder. Raw `env.DB.prepare` is allowed only in `apps/api/src/platform/` (platform tables) and is lint-checked (Biome `noRestrictedImports` + a grep test).
3. Writes set `tenant_id` from the context; any `tenant_id` key in a pushed `row` is ignored (stripped before validation). Conflict targets are `ON CONFLICT(tenant_id, id)`.
4. Responses never contain `tenant_id` except operator endpoints. `change_log.row_json` is built without `tenant_id`.
5. R2 keys are server-prefixed `t/<tenant_id>/…`; the till only ever names the relative key (`products/…`, `shop/logo-…`) ([04 §3.5](04-api.md#35-put-apifileskindidsha256)).
6. Platform tables (`tenants`, `tenant_usage`, `meta`, `expense_category_templates`) are never exposed to tills.
7. Every new endpoint, table or query must add cases to the isolation suite ([10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory)); a PR without them is not done (AGENTS.md §5).

## 6. Free-tier budget per shop

Reference shop (01 §8): 2 tills, 13 h/day open, 150 bills/day, 3 lines/bill.

| Resource (per account, Free) | Per reference shop / day | Planned Bikri share | Shops that fit |
|---|---|---|---|
| Worker requests 100,000/day | ≈ 2,100 (60 s pulls while visible + pushes + files) | 70,000 (30 % kept for the website's other Workers and ops) | ≈ 33 |
| D1 rows written 100,000/day | ≈ 6,500 (≈ 4,500 for bills incl. indexes and `change_log`, + masters, + 1 `tenant_usage` upsert per push, + the 30-day-later prune deletes) | 70,000 | **≈ 10** |
| D1 rows read 5,000,000/day | ≈ 25,000 (indexed pulls, push look-ups) + snapshots of new tills | 3,500,000 | > 100 |
| D1 size 500 MB per DB (Free) | ≈ 50 MB per shop-year (01 §8 estimate; T-062 must measure it with `large.json`) | 1 shard | ≈ 10 shop-years per shard |
| R2 10 GB-month, 1 M Class A/month | ≈ 25 MB photos per shop; ~1 PUT per photo | shared | > 100 |

So **about 10 reference-size shops fit on the Free plan**, limited by rows written; storage then lasts about a year before a second shard or Workers Paid (USD 5/month: 10 GB per database, 50 M rows written and 25 B rows read per month included) is needed.

How the daily row budget is shared:
- `tenants.daily_write_budget` (default **7,000** rows) is set by the operator; the console warns when Σ budgets of active tenants > 70,000.
- Every push batch ends with `INSERT INTO tenant_usage … ON CONFLICT DO UPDATE SET rows_written = rows_written + ?` using the sum of `meta.rows_written` reported by D1 for that batch (and `rows_read`, `pushes`). Snapshot and pull handlers add their `rows_read` on the next push of that device (kept in memory per isolate, best effort) so pulls cost no extra writes.
- Before applying a push, the Worker reads today's (UTC) `tenant_usage` row. At ≥ 100 % of the tenant's budget the push answers `503 TENANT_QUOTA` with `Retry-After` until 00:00 UTC (05:00 PKT); tills keep selling offline and push later (REQ-C01: a quota never blocks a sale). Day close still saves locally and shows "Will sync after 05:00".
- Pull frequency: `/api/me` and pull responses carry `poll_after_ms` (default 60,000; the operator can raise it per tenant, and the Worker doubles it while the tenant is above 80 % of its write budget).
- The account-wide limit is still the hard stop: if D1 itself refuses (`D1_LIMIT`), every tenant waits for 00:00 UTC. The console shows Σ usage across tenants against 100,000.

## 7. Tenant lifecycle

### 7.1 Onboarding a new shop (D-067)

1. **Operator creates the tenant** in the console (`/admin/tenants/new`): shop display name, slug (`[a-z0-9-]{3,30}`, unique, used in the console, backup manifests and file names only, never in till URLs), daily write budget, note. `POST /api/admin/tenants` writes, in one batch: the `tenants` row (`status 'active'`, `db_shard 'DB'`, fresh `restore_epoch`), the default branch (`Main`, `INV`, `is_default 1`), the expense categories copied from `expense_category_templates`, and their `change_log` rows.
2. The same call returns an **owner pairing code**: an enrolment code with `grants_admin = 1`, valid **72 hours**, single use, shown as `XXXX-XXXX` plus QR/link `https://algovyn.com/bikri/enrol?code=…`. The operator sends it to the shop owner out of band (WhatsApp, in person). The console can cancel and re-issue it.
3. The shop owner opens the link on their PC or phone → [enrol screen](screens/02-enrol.md) → the device becomes the shop's first **admin device** → the [setup wizard](screens/01-setup-wizard.md) creates the shop profile (pre-filled with the display name) and the owner staff row with their PIN.
4. The owner adds tills from **Settings → Devices** on an admin device (15-minute codes, admin or not), and staff in Settings → Cashiers. The operator is not needed again.

The operator's own shop is onboarded the same way (Adnan as both operator and a shop owner).

### 7.2 Suspend, reactivate

`status = 'suspended'`: device calls get `403 TENANT_SUSPENDED` (enrol, push, pull, files); tills keep selling offline and can still export locally. Reactivating resumes sync; nothing is lost. Used for non-payment or abuse (see open questions).

### 7.3 Per-tenant export and restore

- **Export (operator):** console → tenant → `Export` pages through `GET /api/admin/tenants/:id/export` (same paging as the snapshot) and builds the `bikri-export` zip ([09 §3.3](09-backups-and-ops.md#33-restore-from-the-owners-json-export-new-deploy--leaving-cloudflare)) in the browser, with `tenant` in `manifest.json`.
- **Export (shop owner):** Settings → Backup → Export (built on the till from IndexedDB; `export.data`). It always contains only that shop's data, because a till only holds its own tenant.
- **Restore one tenant** (mistake, corruption, shard move): never with Time Travel, which would roll back every shop. Instead ([09 §3.4](09-backups-and-ops.md#34-restore-one-tenant)): tenant `status = 'maintenance'` → purge its rows (chunked) → import the export → new `restore_epoch` / `restore_point_at` for that tenant → `active`. The export comes from the operator, the shop owner, or from a nightly backup loaded into the scratch DB `bikri-restore` and extracted with `tools/backup/tenant-extract.mjs`.

### 7.4 Delete a tenant

Operator → tenant → `Delete` (type the slug to confirm; only after a final export is offered): `status = 'deleting'`, all its devices revoked (tokens stop at once), then the nightly cron deletes its rows child-tables first, at most 20,000 rows per night across all deleting tenants (deletes count as rows written), and deletes its R2 prefix `t/<tenant_id>/` (deletes are free). When nothing is left the `tenants` row becomes `status = 'deleted'` (id, slug, timestamps kept as a tombstone so the slug is not reused by mistake). Data still exists in the encrypted nightly backups until they age out (30 daily + 12 monthly, [09 §2](09-backups-and-ops.md#2-nightly-backup-workflow-githubworkflowsbackupyml)); see open questions.

## 8. Migration plan from the single-shop M0 code (D-072)

M0 (PRs #1 and #2) was merged but **never deployed**: `DEPLOY_ENABLED` is unset, so `wrangler d1 migrations apply --remote` never ran. `apps/api/wrangler.jsonc` points at a real D1 database `bikri`, but no deploy has applied the migrations to it (this was not re-checked against Cloudflare when writing this doc; the check below covers it).

- **Edit `0001_init.sql` and `0002_seed.sql` in place** (no `0003`): there is no deployed schema to stay compatible with, and an additive `0003` cannot turn single-column primary keys into composite ones (SQLite needs a table rebuild). `SCHEMA_VERSION` stays `1`. Before the first deploy, check `wrangler d1 migrations list bikri --remote` shows nothing applied; if something was applied, delete and re-create the empty `bikri` database (operator decision) rather than writing a rebuild migration.
- This docs PR changes the SQL blocks in [02 §2](02-data-model.md#2-d1-schema-migration-0001_initsql); `tools/check-docs.mjs` will report the two migration files out of sync until **T-008** (the first phase 2 task) copies them and rewrites `apps/api/test/migrations.test.ts` for two tenants.
- Other M0 single-shop assumptions and what replaces them:

| M0 assumption | Multi-tenant replacement |
|---|---|
| `shop` singleton `id CHECK (id = 'shop')` | one `shop` row per tenant: PK `(tenant_id, id)`, `id` still `'shop'` |
| global uniques: `bill_prefix`, `sku`, `barcode`, `expense_categories.code`, `sales.invoice_no` | per tenant (§3.2) |
| global `meta` (schema_version, restore_epoch, restore_point_at, writes_today/date, change_log_floor) | `meta` keeps `schema_version` and gains `last_prune_at`, `prune_cursor`; `restore_epoch`, `restore_point_at`, `change_log_floor` move to `tenants`; usage moves to `tenant_usage` |
| `0002_seed` system expense categories without tenant | seeded into `expense_category_templates`; copied per tenant at creation |
| one global `change_log.seq` stream; `applied_ops`, `sync_conflicts` unscoped | `seq` stays one stream per database (cursors are per tenant: `WHERE tenant_id = ? AND seq > ?`, gaps are fine); `change_log`, `applied_ops`, `sync_conflicts` get `tenant_id`, keys `(tenant_id, …)` |
| `devices`, `enrolment_codes` linked only to a branch | `tenant_id` + composite FK to the branch; `token_hash` and `code_hash` stay globally unique (they identify the tenant); `is_admin`, `grants_admin` added |
| cron `prune.ts` deployment-wide | still one cron (no extra trigger), but floors are per tenant and it also runs tenant deletion ([03 §4.4](03-sync.md#44-retention-pruning-and-stale-tills)) |
| one `DB` binding used directly | `tenantDb(env, tenant)` resolves `tenants.db_shard` (v1 always `DB`) |
| localStorage `bikri.language`, `bikri.persist` | device-level, not shop data: they stay per browser. `bikri.language` is only the pre-enrolment default; after enrolment the language lives in the tenant's Dexie `kv.language`. A new non-secret key `bikri.active_tenant` points at the tenant's Dexie database `bikri-<tenant_id>` (D-068) |
| `ReceiptShop` printer parameter | already per call: unchanged |
| `SHOP_TIMEZONE` Worker var | default only; each tenant's `shop.timezone` is authoritative |

Phase 2 work already done on `phase-2-local-till` (T-010 money, part of T-019 printer) is unaffected and is rebased after this PR.

## 9. Open questions (owner decision needed)

1. **Pricing and billing** for other shops: free, flat monthly fee, or per till? Who pays when Bikri needs Workers Paid (USD 5/month) or more? Should over-budget shops be suspended or slowed?
2. **Self-service export:** can shop owners download a server-side export of their shop themselves (an owner-only `GET /api/shop/export`), or only the on-device export plus an operator export on request?
3. **Stronger shop-owner sign-in:** v1 shop-admin actions need an admin device plus a locally checked owner PIN ([05 §3](05-auth-and-roles.md#3-shop-admin-on-admin-devices)). Add passkeys (WebAuthn) or email OTP for shop owners in v1, or later?
4. **Deleted-shop data in backups:** is it acceptable that a deleted shop's data stays in encrypted backups for up to 12 months (monthly backups) and 90 days (GitHub artifacts), or should deletion also shorten retention?
5. **Terms and privacy:** the operator can technically read every shop's data (D1 access and the backup key). Should Bikri show terms/privacy text to new shop owners, and should operator exports be logged visibly to the shop (an audit row in their Activity)?
6. **Operator support access:** may the operator enrol a browser into a customer's shop for support (audited), or only see usage and devices?
7. **One browser, several shops:** v1 allows one active shop per browser profile (D-068). Is switching between shops on one PC needed (e.g. one person running two businesses)?
8. **Default daily write budget** per shop (7,000 rows) and the 30 % reserve for the other Algovyn Workers: right numbers?
9. **Branding:** receipts and the PWA show each shop's own name and logo; the app stays "Bikri" with Algovyn colours. Should other shops' receipts carry any "Powered by Bikri" line (currently none, REQ-B03)?
