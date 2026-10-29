# 13 — Multi-tenancy

Bikri is **multi-tenant** (decision [D-069](decisions.md), superseding D-001). One deployment at `https://algovyn.com/bikri/` serves several independent shops (**tenants**), run by one **platform operator** (Adnan, `adnan@yaqoob.org`). Each tenant has its own staff, branches, tills, products, stock, sales, udhaar, suppliers, expenses, settings, receipts and files, and **must never see or change another tenant's data**.

This doc holds the tenancy model, the facts it is based on, the per-shop free-tier budget, the tenant lifecycle (onboarding, read-only and suspension, export, restore, deletion, operator support access), the migration plan from the single-shop M0 code, and the questions only the owner can answer. The other docs apply it: schema [02](02-data-model.md), sync [03](03-sync.md), API [04](04-api.md), auth [05](05-auth-and-roles.md), backups [09](09-backups-and-ops.md), tests [10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory), roadmap [11](11-roadmap.md). Decisions: D-069–D-079, and the owner's answers to the first open questions D-080–D-085, in the [decisions log](decisions.md).

## 1. Terms

| Term | Meaning |
|---|---|
| **Tenant** | One business using Bikri: its own `shop` row, branches, devices, staff and every business record. Row in `tenants`; id `tenant_id` (ULID). "Shop" in the UI. |
| **Platform operator** | The person who runs the deployment (v1: only `adnan@yaqoob.org`). Creates, suspends and deletes tenants, sees usage, holds the backup key. Not a staff member of any shop. |
| **Shop owner** | The `owner`-role staff member of one tenant. Manages that shop only. |
| **Admin device** | A till with `devices.is_admin = 1`, allowed to call the shop-admin API (create enrolment codes, manage devices, server export) for its own tenant after an owner email sign-in ([05 §3](05-auth-and-roles.md#3-shop-admin-on-admin-devices)). |
| **Support device** | A browser the operator enrolled into a shop for support (`devices.kind = 'support'`): view-only, time-limited, announced by a banner on the shop's tills (§7.5). |
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
| Email Sending to **arbitrary** recipients | **not available on Workers Free**; Workers Paid: 3,000 emails/month included, then USD 0.35 per 1,000 | [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) |
| Email to **verified destination addresses** | free on every plan, including when only Email Routing is configured; does not count toward any quota or daily limit; sent from a `send_email` Worker binding; "You can only send from your routing domains" until a sending domain is onboarded | [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) |
| Destination addresses | **200 per account**, shared by all domains; each is verified by Cloudflare emailing a link that the address owner must click | [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/), [Routing addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) |
| `send_email` binding restrictions | `allowed_sender_addresses`, `allowed_destination_addresses`, `destination_address` | [Send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/) |
| Workers Rate Limiting binding (`ratelimits`) | available on Free, no extra charge; period 10 or 60 s; counts are approximate and per Cloudflare location | [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) |
| `algovyn.com` mail | MX already points at Cloudflare Email Routing (`route1-3.mx.cloudflare.net`, checked by DNS lookup on 27 Oct 2026), so `algovyn.com` is a routing domain | DNS |

Consequences: the daily D1 row limits and the Workers request limit are **per account**, so they are shared by every tenant (and by the other Algovyn Workers such as SmartGrind and MarkSocial) whichever database layout is used. Only storage (500 MB) is per database.

## 3. Tenancy model (D-069)

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
| D1 rows written 100,000/day | ≈ 17,550 (T-062 measured 117 rows/bill for a 3-line reference bill incl. indexes, `change_log` and `applied_ops`; 150 bills/day) | 70,000 | **≈ 4** at the 70 % share (5.7 at the hard limit) |
| D1 rows read 5,000,000/day | ≈ 25,000 (indexed pulls, push look-ups) + snapshots of new tills | 3,500,000 | > 100 |
| D1 size 500 MB per DB (Free) | ≈ 153 MB per shop-year (T-062 measured 1.9 KB/bill permanent + steady-state 30-day `change_log`/90-day `applied_ops` at 150 bills/day, 419 KB/shop-day) | plan a new shard at ~450 MB | **≈ 3.3 shop-years per DB** |
| R2 10 GB-month, 1 M Class A/month | ≈ 25 MB photos per shop; ~1 PUT per photo | shared | > 100 |

So **about 4 reference-size shops fit inside the planned 70,000-row share** (5.7 at the 100,000 account limit); 10 shops need Workers Paid or lower volume. Storage is not the binding limit for that smaller set: those 4 shops need about **1–2 databases after a year** (≈33 shop-years across the 10-database allowance), so add a shard when a DB reaches ~450 MB. Workers Paid (USD 5/month: 10 GB per database, 50 M rows written and 25 B rows read per month included) removes the storage pressure. The measurement is reproducible with `node tools/perf/measure-d1.mjs` ([T-062](11-roadmap.md)).

How the daily row budget is shared:
- `tenants.daily_write_budget` (console/API default **18,000** rows; schema default 7,000 for direct inserts) is set by the operator; the console warns when Σ budgets of active tenants > 70,000. A reference shop needs ~18,000, so four fit the 70 % share.
- Every push batch ends with `INSERT INTO tenant_usage … ON CONFLICT DO UPDATE SET rows_written = rows_written + ?` using the sum of `meta.rows_written` reported by D1 for that batch (and `rows_read`, `pushes`). Snapshot and pull handlers add their `rows_read` on the next push of that device (kept in memory per isolate, best effort) so pulls cost no extra writes.
- Before applying a push, the Worker reads today's (UTC) `tenant_usage` row. At ≥ 100 % of the tenant's budget the push answers `503 TENANT_QUOTA` with `Retry-After` until 00:00 UTC (05:00 PKT); tills keep selling offline and push later (REQ-C01: a quota never blocks a sale). Day close still saves locally and shows "Will sync after 05:00".
- Pull frequency: `/api/me` and pull responses carry `poll_after_ms` (default 60,000; the operator can raise it per tenant, and the Worker doubles it while the tenant is above 80 % of its write budget).
- The account-wide limit is still the hard stop: if D1 itself refuses (`D1_LIMIT`), every tenant waits for 00:00 UTC. The console shows Σ usage across tenants against 100,000.

## 7. Tenant lifecycle

### 7.1 Onboarding a new shop (D-072)

1. **Operator creates the tenant** in the console (`/admin/tenants/new`): shop display name, slug (`[a-z0-9-]{3,30}`, unique, used in the console, backup manifests and file names only, never in till URLs), owner email (for owner email sign-in, [05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082); the operator also adds it as a Cloudflare Email Routing destination address so the owner can verify it), daily write budget, note. `POST /api/admin/tenants` writes, in one batch: the `tenants` row (`status 'active'`, `db_shard 'DB'`, fresh `restore_epoch`), the default branch (`Main`, `INV`, `is_default 1`), the expense categories copied from `expense_category_templates`, and their `change_log` rows.
2. The same call returns an **owner pairing code**: an enrolment code with `grants_admin = 1`, valid **72 hours**, single use, shown as `XXXX-XXXX` plus QR/link `https://algovyn.com/bikri/enrol?code=…`. The operator sends it to the shop owner out of band (WhatsApp, in person). The console can cancel and re-issue it.
3. The shop owner opens the link on their PC or phone → [enrol screen](screens/02-enrol.md) → the device becomes the shop's first **admin device** → the [setup wizard](screens/01-setup-wizard.md) creates the shop profile (pre-filled with the display name) and the owner staff row with their PIN.
4. The owner adds tills from **Settings → Devices** on an admin device (15-minute codes, admin or not), and staff in Settings → Cashiers. The operator is not needed again.

The operator's own shop is onboarded the same way (Adnan as both operator and a shop owner).

### 7.2 Shop status: active, read-only, suspended (D-080)

The operator sets a shop's status in the console (Tenant → Summary). Every change needs a reason (1–200 characters), sets `tenants.status`, `status_reason`, `status_changed_at`, `status_changed_by`, and writes one `audit_log` row **in that shop** in the same batch: `action = 'tenant_status_change'`, `entity = 'shop'`, `entity_id = 'shop'`, `before_json = { "status": "active" }`, `after_json = { "status": "read_only", "reason": "…", "by": "operator:adnan@yaqoob.org" }`, `device_id = 'server'`, `staff_id` = the shop's first owner (or `'server'` before setup). The row syncs to the shop's tills, so the owner sees it in Settings → Activity. The console also lists the status history of each shop from these rows.

| Status | Who sets it | Sign in (enrol, PIN unlock, owner email sign-in) | Pull, snapshot, `/api/me`, file download, reports and history | Owner exports (device and server) | New business data (push, file upload) |
|---|---|---|---|---|---|
| `active` | operator (create, reactivate) | yes | yes | yes | yes |
| **`read_only`** | operator, manually | yes | yes | yes | **no**: `403 TENANT_READ_ONLY` (ops made before the till learned the status are still accepted, below) |
| `suspended` | operator | no (`403 TENANT_SUSPENDED`) | no | on the device only | no on the server; tills keep selling offline and push after reactivation |
| `maintenance` | operator during a restore (§7.3) | no (`503 MAINTENANCE`) | no | on the device only | no (kept and retried) |
| `deleting` / `deleted` | operator delete / cron (§7.4) | no (devices revoked) | no | no | no |

**Read-only** is the lever for non-payment, and the operator can also use it by hand for any other reason (a shop closing down, a dispute, before deleting a shop). Billing is not automated in v1, so read-only is never set automatically; pricing is still an open question (§9). Over-budget shops are **not** made read-only: they keep the existing quota behaviour (sync pauses with `TENANT_QUOTA` until 00:00 UTC, §6). **Suspended** stays for abuse or emergencies: it stops all server access, while a read-only shop can still sign in, look at its data and take it away.

What read-only allows and blocks:
- Allowed: enrol a device, PIN unlock, owner email sign-in (05 §3.2), pull, snapshot, `/api/me`, `GET /api/files/*`, every report, list and bill on the till, CSV/PDF and full exports on the device, the owner's server export (§7.3), and shop-admin actions that are not business data (list, rename and revoke devices, issue and cancel enrolment codes, end operator support access).
- Blocked: every push of new ops (sales, refunds, voids, udhaar entries and payments, stock adjustments and counts, products and prices, customers, suppliers, deliveries, supplier returns, expenses, cash moves, day closes, staff and shop settings), `PUT /api/files/*`, `POST /api/shop/import-ops` for ops created after the read-only start, and conflict acknowledgement. The answer is `403 TENANT_READ_ONLY` with `details: { since }`.
- Local-only device settings (printer, scanner, display, language) still work, because they are not shop data.

**How tills learn it.** `/api/me` (called at app start and every `poll_after_ms`), and every pull and push response, carry `tenant_status: { status, since }`. When the server sends `read_only` to a device for the first time it also sets `devices.read_only_seen_at = now` (server clock, one write per device). The till saves `kv.tenant_status` and enters **read-only mode** at once: the repository layer refuses every write that would create an outbox op (one guard in `apps/pos/src/data/`, so no screen can bypass it), Sell, Pay, Refund, Void, Udhaar, Stock, Products, Suppliers, Expenses and Day close show their data but hide or disable their actions, carts and held bills stay on the device, and a non-dismissable banner shows on every screen (§7.2.1). An offline till learns it on its next successful request.

**Rule for ops made offline before the till learned it.** A sale made while the till could not know is a real event and is never lost:
1. A push from a device whose `read_only_seen_at` is NULL is applied in full (every op in it was created before the device was told), and the response tells the device (`read_only_seen_at` is set in the same batch).
2. Later pushes apply only the ops with `created_at ≤ read_only_seen_at + 10 minutes` (allowance for a slow device clock), whole transactions only (`tx_id`, D-054). The other ops are **omitted from `results`** and stay pending on the till, exactly like ops that did not fit in a request (03 §4.1 step 7, D-029); if no op qualifies the push gets `403 TENANT_READ_ONLY`. The till never creates such ops itself; they can only exist through a wrong clock or a modified client, and they sync once the shop is reactivated. They are never discarded.
3. Settings → Sync lists pending ops held back by read-only as "Waiting: this shop is read-only".
4. The operator's console shows, per device, `read_only_seen_at` and pending ops, so they can see what is still waiting.

Reactivating (`read_only` → `active`) clears `read_only_seen_at` on all the shop's devices in the same batch; tills leave read-only mode on their next `/api/me` or pull and push anything still pending. Restore's `maintenance off` asks which status to return to (default: the status before maintenance, read from the last `tenant_status_change` row).

#### 7.2.1 Banner texts (i18n keys; native-speaker review in T-063)

| Key | en | ur | roman-ur |
|---|---|---|---|
| `tenant.readOnly.banner` | This shop is read-only. You can view reports and history and export your data, but you can't make sales or changes. Contact Algovyn. | یہ دکان صرف دیکھنے کے لیے ہے۔ آپ رپورٹس اور ریکارڈ دیکھ سکتے ہیں اور اپنا ڈیٹا ایکسپورٹ کر سکتے ہیں، لیکن نئی سیل یا کوئی تبدیلی نہیں کر سکتے۔ الگوون سے رابطہ کریں۔ | Yeh dukaan sirf dekhne ke liye hai. Aap reports aur record dekh sakte hain aur apna data export kar sakte hain, lekin nayi sale ya koi tabdeeli nahin kar sakte. Algovyn se rabta karein. |
| `tenant.readOnly.blocked` (toast on a blocked action) | Read-only shop: this can't be saved. | دکان صرف دیکھنے کے لیے ہے: یہ محفوظ نہیں ہو سکتا۔ | Dukaan sirf dekhne ke liye hai: yeh save nahin ho sakta. |
| `tenant.readOnly.waiting` (Settings → Sync) | Waiting: this shop is read-only | انتظار: یہ دکان صرف دیکھنے کے لیے ہے | Intezar: yeh dukaan sirf dekhne ke liye hai |

The banner uses the warning tokens (`--color-warning-subtle` / ink, [08 §2](08-ux-guidelines.md#2-design-tokens-appspossrcstylestokenscss-tailwind-4-theme)), sits under the top bar on every screen including the PIN lock, and has `role="status"`.

### 7.3 Per-tenant export and restore

- **Export (operator):** console → tenant → `Export` pages through `GET /api/admin/tenants/:id/export` (same paging as the snapshot) and builds the `bikri-export` zip ([09 §3.3](09-backups-and-ops.md#33-restore-from-the-owners-json-export-new-deploy--leaving-cloudflare)) in the browser, with `tenant` in `manifest.json`.
- **Export (shop owner, on the device):** Settings → Backup → Export (built on the till from IndexedDB; `export.data`). It always contains only that shop's data, because a till only holds its own tenant.
- **Export (shop owner, from the server, D-081):** Settings → Backup → `Download from server` on an admin device, unlocked as an owner, with an owner email sign-in (05 §3.2). It pages through `GET /api/shop/export` (same paging and table list as the snapshot, [03 §4.3](03-sync.md#43-snapshot--get-apisyncsnapshot); `devices` without `token_hash`; never `owner_email_codes` or platform tables) and builds the same `bikri-export` zip (JSON + CSV, [09 §3.3](09-backups-and-ops.md#33-restore-from-the-owners-json-export-new-deploy--leaving-cloudflare)) **in the browser**, with `manifest.source = "server"` and `snapshot_seq`. Unlike the device export it includes rows from every till of the shop, also revoked or lost ones. Tenant scope comes only from the device token (no tenant in the request), so it is covered by the isolation suite (I22). Allowed when the shop is `active` or `read_only`.
  - Why the browser builds the zip: zipping a large shop takes far more than the Free plan's **10 ms CPU per request**, and storing a ready zip in R2 would mean a background job and another copy of personal data. Each page is one indexed range read of ≤ 500 rows, which fits the CPU limit.
  - Free-tier cost and limits: a reference shop after a year has about 300,000 rows, so one export is about 600 Worker requests (0.6 % of the account's 100,000/day) and 300,000 D1 rows read (6 % of 5,000,000/day). Therefore **one server export start per shop per 24 hours** (`tenants.last_owner_export_at`; else `429 RATE_LIMITED` with `Retry-After`), and a started export stays valid for 2 hours (signed `export_id`, so an interrupted download resumes without a new start). Rows read are added to `tenant_usage.rows_read` like snapshot reads; reads never count against the write budget.
  - Audit: the start writes `audit_log` `owner_export` (staff, device, `after_json: { tables, rows }`) in the shop. The operator sees owner exports in the console.
- **Restore one tenant** (mistake, corruption, shard move): never with Time Travel, which would roll back every shop. Instead ([09 §3.4](09-backups-and-ops.md#34-restore-one-tenant)): tenant `status = 'maintenance'` → purge its rows (chunked) → import the export → new `restore_epoch` / `restore_point_at` for that tenant → `active`. The export comes from the operator, the shop owner, or from a nightly backup loaded into the scratch DB `bikri-restore` and extracted with `tools/backup/tenant-extract.mjs`.

### 7.4 Delete a tenant

Operator → tenant → `Delete` (type the slug to confirm; only after a final export is offered): `status = 'deleting'`, all its devices revoked (tokens stop at once), then the nightly cron deletes its rows child-tables first, at most 20,000 rows per night across all deleting tenants (deletes count as rows written), and deletes its R2 prefix `t/<tenant_id>/` (deletes are free). When nothing is left the `tenants` row becomes `status = 'deleted'` (id, slug, timestamps kept as a tombstone so the slug is not reused by mistake; `owner_email` is cleared). **Retention after deletion (D-083, owner decision):** the shop's data stays in the nightly backups (private R2, provider-encrypted; the off-site copy is age-encrypted) until they age out: up to **30 days** in the daily R2 backups, up to **12 months** in the monthly R2 backups, and up to **90 days** in the encrypted GitHub Actions artifacts ([09 §2](09-backups-and-ops.md#2-nightly-backup-workflow-githubworkflowsbackupyml)). Deleting a shop does not shorten that retention, and a deleted shop is never restored from a backup unless its owner asks. This is stated to shop owners in the terms and privacy notes ([09 §6.1](09-backups-and-ops.md#61-terms-and-privacy-notes-for-shop-owners)).

### 7.5 Operator support access (D-084)

The operator may join a shop's devices to help with support. It is always **explicit, visible, time-limited and audited**:

1. **Start.** Console → tenant → `Support access` → reason (required, 3–200 characters) and duration (1, 2, 4, 8 or 24 hours; default 2) → `POST /api/admin/tenants/:id/support-access`. In one batch: `tenants.support_until = now + duration`, `support_reason`, a single-use **support enrolment code** (`enrolment_codes.kind = 'support'`, 15 minutes, never `grants_admin`), and an `audit_log` row `support_access_start` in the shop (`after_json: { reason, until, by: 'operator:<email>' }`). Only one grant at a time; starting again extends it (new audit row). Allowed when the shop is `active` or `read_only`.
2. **Join.** The operator opens the enrol link in a **separate browser profile** (one shop per browser, D-073). The device is created with `kind = 'support'`, name "Algovyn support", `is_admin = 0`, `expires_at = support_until`. On that device the PIN lock offers one extra local profile "Algovyn support" (not a `staff` row, no PIN) with view-only permissions: every screen, report, bill, Activity, Settings → Sync and Devices lists, but no action that writes. The repository guard of read-only mode (§7.2) is always on for support devices, and the server refuses any push or upload from a `support` device with `403 FORBIDDEN`. Fixes are made with the console's audited tools (unsynced-ops import, owner PIN reset, restore), never by typing into the shop's till.
3. **Visible.** While `support_until > now`, `/api/me` and pull responses carry `support: { until, reason }`, and every till of the shop shows an info banner on every screen: "Algovyn support has access to this shop until {time}. Reason: {reason}." with `End now` for an owner. The support device is listed in Settings → Devices with a "Support" badge. A till learns it on its next `/api/me` or pull; support only reads server data, so an offline till missing the banner is not a risk.
4. **End.** Whichever comes first: the time runs out (`deviceAuth` treats a support device past `expires_at` as revoked, `401 DEVICE_REVOKED`); the operator presses `End support access` (`POST …/support-access/end`); or a shop owner presses `End now` on an admin device after a PIN unlock (`POST /api/shop/support-access/end`; no email sign-in needed, because it only removes access). Ending sets `support_until = now`, revokes the shop's support devices and writes `support_access_end` (`after_json: { ended_by: 'operator' | 'owner' | 'expiry' }`); the expiry row is written by the next `/api/me` call that notices it or by the nightly cron, whichever is first.

What is not logged: the individual reads made by the support device (logging each request would cost D1 writes); the start and end rows, the device row and the operator's console actions are the record. Banner texts:

| Key | en | ur | roman-ur |
|---|---|---|---|
| `tenant.support.banner` | Algovyn support has access to this shop until {time}. Reason: {reason}. | الگوون سپورٹ کو {time} تک اس دکان تک رسائی حاصل ہے۔ وجہ: {reason}۔ | Algovyn support ko {time} tak is dukaan tak rasai hasil hai. Wajah: {reason}. |
| `tenant.support.end` | End now | ابھی ختم کریں | Abhi khatam karein |

## 8. Migration plan from the single-shop M0 code (D-077)

M0 (PRs #1 and #2) was merged but **never deployed**: `DEPLOY_ENABLED` is unset, so `wrangler d1 migrations apply --remote` never ran. `apps/api/wrangler.jsonc` points at a real D1 database `bikri`, but no deploy has applied the migrations to it (this was not re-checked against Cloudflare when writing this doc; the check below covers it).

- **T-008 rewrote `0001_init.sql` and `0002_seed.sql` in place** while M0 was still undeployed; an additive migration could not turn single-column primary keys into composite ones (SQLite needs a table rebuild). That rewrite is history. After the first remote deploy every schema change is an additive `000N_*.sql` migration: T-062 added `0003_perf_indexes.sql`. `SCHEMA_VERSION` stays `1` for index-only changes and is bumped when columns change.
- The SQL blocks in [02 §2](02-data-model.md#2-d1-schema-migration-0001_initsql) are the source of truth and `tools/check-docs.mjs` checks all three migration files against them.
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
| localStorage `bikri.language`, `bikri.persist` | device-level, not shop data: they stay per browser. `bikri.language` is only the pre-enrolment default; after enrolment the language lives in the tenant's Dexie `kv.language`. A new non-secret key `bikri.active_tenant` points at the tenant's Dexie database `bikri-<tenant_id>` (D-073) |
| `ReceiptShop` printer parameter | already per call: unchanged |
| `SHOP_TIMEZONE` Worker var | default only; each tenant's `shop.timezone` is authoritative |

## 9. Open questions (owner decision needed)

Answered on 27 Oct 2026 and recorded as D-080–D-085: read-only shops (§7.2), the owner's server export (§7.3), owner email sign-in ([05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082)), backup retention after deletion (§7.4), operator support access (§7.5) and the "Powered by AlgoVyn" receipt line ([06 §4](06-printing.md#4-receipt-templates)). Still open:

1. **Pricing and billing amounts** for other shops: free, flat monthly fee, or per till? Who pays when Bikri needs Workers Paid (USD 5/month) or more? (The enforcement lever is decided: the operator makes a shop read-only, D-080; whether billing is ever automated is part of this question.)
2. **Terms acceptance:** the terms and privacy notes ([09 §6.1](09-backups-and-ops.md#61-terms-and-privacy-notes-for-shop-owners)) are shown to shop owners as information. Must a new owner explicitly accept them (a checkbox at the owner pairing step), and should the text get a legal review before the first outside shop joins?
3. **One browser, several shops:** v1 allows one active shop per browser profile (D-073). Is switching between shops on one PC needed (e.g. one person running two businesses)?
4. **Default daily write budget** per shop (now 18,000 rows) and the 30 % reserve for the other Algovyn Workers: right numbers?
5. **Email beyond verified addresses:** on the Free plan each shop owner's email must be a verified destination address in Cloudflare (the owner clicks Cloudflare's verification email once; at most 200 addresses per account). Moving to Workers Paid and onboarding `algovyn.com` as a sending domain (new SPF/DKIM DNS records) removes that step. When shops grow, switch, or keep verified addresses?
6. **Owner self-recovery:** should an owner who lost every admin device be able to make a till an admin device with their email code, instead of asking the operator for a new owner pairing code (current design)?
7. **Writes by support access:** support devices are view-only (§7.5). Should the operator ever be allowed to make changes in a shop's data from a support device (for example with the owner's explicit approval per session)?


**File storage per shop.** The till file API rejects an upload that would take a shop over 1 GB or that targets a product not in that shop; the shared R2 bucket cannot be filled by one tenant.
