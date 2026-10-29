# 01 — Architecture

## 1. Summary

| Concern | Decision |
|---|---|
| Client | React 19 + Vite + TypeScript PWA (`apps/pos`) |
| Local data | IndexedDB via Dexie 4 — the till's source of truth for reads and writes |
| Server | One Cloudflare Worker (`apps/api`) running Hono: JSON API under `/bikri/api/*` + static assets for the PWA under `/bikri/` |
| Tenancy | **Multi-tenant**: many shops on one deployment, one shared D1 with `tenant_id` on every tenant row, composite keys, a tenant-scoped data layer; shard-ready ([13](13-multi-tenancy.md), D-069) |
| Database | Cloudflare D1 (SQLite), binding `DB` (primary database: platform tables + all tenants in v1) |
| Files | Cloudflare R2 bucket `bikri-files`, binding `FILES` (logo, product photos only, keys prefixed `t/<tenant_id>/`); separate bucket `bikri-backups`, binding `BACKUPS` (nightly D1 exports, admin-only) |
| Auth | Device token (Bearer, identifies the tenant) for the till API; staff PIN on the device; admin devices for the shop-admin API `/bikri/api/shop/*`; Cloudflare Access (email OTP, only the platform operator `adnan@yaqoob.org`) for the operator console `/bikri/admin*` and `/bikri/api/admin/*` ([05](05-auth-and-roles.md)) |
| Sync | Outbox push + cursor pull ([03-sync](03-sync.md)) |
| Printing | Printer-agnostic ESC/POS over WebUSB **or** Web Serial, 58 mm or 80 mm paper; browser print (`window.print`) fallback ([06-printing](06-printing.md)) |
| Hosting | Cloudflare free tier, **path-based at `https://algovyn.com/bikri/`** on the existing `algovyn.com` zone, via Worker routes (§5.3) |
| Backups | GitHub Actions nightly `wrangler d1 export` of the whole database (all tenants) → R2 + copy encrypted with the operator's `age` key; per-tenant export/restore in the console ([09](09-backups-and-ops.md)) |

### Why React (not Svelte)

Svelte would ship a smaller bundle, but the service worker caches the app so bundle size only matters on first load. React wins on the libraries Bikri relies on: `dexie-react-hooks` (`useLiveQuery` re-renders when IndexedDB changes), `react-i18next` with RTL, TanStack Router/Virtual for long lists, and Radix primitives that handle focus, keyboard and RTL. It is also the most widely known stack if another developer or agent takes over.

### Why one Worker with static assets (not Pages + Worker)

Cloudflare Workers can serve static assets directly. One deployable means one origin (no CORS), one `wrangler.jsonc`, one CI job, and the API and the app versions always match. Cloudflare Pages + Functions would also work; this doc assumes Workers static assets.

### 1.1 URL layout and the path convention used in these docs

Bikri lives at **`https://algovyn.com/bikri/`** (decision D-021). It is not a subdomain: the rest of `algovyn.com` stays the Algovyn website.

| Public URL | Served by | Notes |
|---|---|---|
| `https://algovyn.com/` and every path not under `/bikri` | the existing Algovyn website (unchanged) | Bikri never touches these paths |
| `https://algovyn.com/bikri` | Bikri Worker (asset server) | redirected to `/bikri/` by the asset server's default `html_handling: "auto-trailing-slash"` (the Worker script does not run for it) |
| `https://algovyn.com/bikri/` … (`/bikri/sell`, `/bikri/settings/printer` …) | Bikri Worker → static assets (SPA) | app routes |
| `https://algovyn.com/bikri/api/*` | Bikri Worker → Hono | till API (device token) and shop-admin API `/bikri/api/shop/*` (admin device) |
| `https://algovyn.com/bikri/admin*` | Bikri Worker → static assets, behind Cloudflare Access | platform operator console |
| `https://algovyn.com/bikri/api/admin/*` | Bikri Worker → Hono, behind Cloudflare Access | platform operator API |

**No shop in the URL.** Every shop uses the same app URL `https://algovyn.com/bikri/`; a till knows its shop from its device token (the server) and from `localStorage['bikri.active_tenant']` → Dexie database `bikri-<tenant_id>` (the browser), see D-073. Shop slugs appear only in the operator console and backup manifests, so URLs never reveal which shops exist and the PWA has one scope and one install.

**Convention:** everywhere else in these docs (screen specs, sync, API tables), app routes such as `/sell`, `/enrol`, `/admin` and API paths such as `/api/sync/push` are written **relative to the base path `/bikri`**. So `/sell` means `https://algovyn.com/bikri/sell` and `/api/sync/push` means `https://algovyn.com/bikri/api/sync/push`. Never hard-code `/bikri` in components or fetch calls; use the single constants below.

| Where | Setting |
|---|---|
| `packages/core/src/paths.ts` | `export const BASE_PATH = '/bikri'; export const API_BASE = `${BASE_PATH}/api`;` (used by the client `fetch` wrapper and the Worker) |
| `apps/pos/vite.config.ts` | `base: '/bikri/'`, `build.outDir: 'dist/bikri'` (assets directory must mirror the public path, §5.1) |
| TanStack Router | `createRouter({ routeTree, basepath: '/bikri' })` |
| Hono | `new Hono().basePath('/bikri/api')` |
| PWA manifest | `id: '/bikri/'`, `start_url: '/bikri/'`, `scope: '/bikri/'` (§6) |
| Service worker | file `/bikri/sw.js` → default scope `/bikri/`; never registered at `/` |
| Vite dev server | `http://localhost:5173/bikri/`, proxy `/bikri/api` → `wrangler dev` on `:8787` |

## 2. System diagram

```mermaid
flowchart TB
  subgraph Counter["Counter PC / phone (Chrome)"]
    UI["Bikri PWA<br/>React + Vite"]
    SW["Service worker<br/>(Workbox precache)"]
    IDB[("IndexedDB (Dexie)<br/>data + outbox")]
    HW["Printer / drawer / scanner<br/>WebUSB · Web Serial · HID"]
    UI <--> IDB
    UI --> HW
    SW -. serves app shell offline .-> UI
  end

  subgraph CF["Cloudflare (free tier)"]
    SITE["Algovyn website<br/>algovyn.com/* (unchanged)"]
    W["Worker 'bikri' (routes algovyn.com/bikri, /bikri/*)<br/>Hono: /bikri/api/*<br/>+ static assets /bikri/*"]
    ACC["Cloudflare Access<br/>/bikri/admin*, /bikri/api/admin/*<br/>operator adnan@yaqoob.org only"]
    D1[("D1 'bikri'<br/>tenants + every shop's rows (tenant_id)")]
    R2[("R2 'bikri-files' t/&lt;tenant&gt;/… (logo, photos)<br/>+ 'bikri-backups' (D1 exports)")]
  end

  GH["GitHub Actions<br/>nightly backup + deploy"]
  OFF[("Off-Cloudflare copy<br/>private repo / Drive")]

  IDB -- "push / pull (Bearer device token → tenant)" --> W
  ACC -. guards .-> W
  W --> D1
  W --> R2
  GH -- "wrangler d1 export" --> D1
  GH --> R2
  GH --> OFF
```

## 3. Stack and versions

Pin exact versions in `package.json` at scaffold time. The table lists the latest stable versions checked on 26 Oct 2026; use these or newer patch/minor releases.

| Package | Version | Where | Notes |
|---|---|---|---|
| Node.js | 24 LTS | tooling | `.nvmrc` = `24` |
| pnpm | 12.x | tooling | `packageManager` field |
| turbo | 2.11 | tooling | task pipeline |
| @biomejs/biome | 2.6 | tooling | lint + format |
| typescript | **7.0.2** (exact) | all | Latest stable on npm, checked 27 Oct 2026 (`npm view typescript version` → `7.0.2`; `beta` is 7.1.0-beta). Native (Go) compiler. See §3.1 |
| react / react-dom | 19.3 | pos | |
| vite | 8.3 | pos | |
| vite-plugin-pwa | 2.0 | pos | Workbox `generateSW`, `registerType: 'prompt'` |
| @tanstack/react-router | 1.170 | pos | file-based routes |
| @tanstack/react-virtual | 3.14 | pos | product grid, long lists |
| tailwindcss | 4.3 | pos | CSS-first config with tokens from doc 08 |
| Radix UI primitives / shadcn/ui | latest | pos | dialogs, tabs, popovers |
| dexie / dexie-react-hooks | 4.4 / 4.4 | pos | |
| zustand | 5.0 | pos | carts, UI state |
| i18next / react-i18next | 26.5 / 17.1 | pos | |
| react-hotkeys-hook | 5.3 | pos | |
| ulidx | 2.4 | core | `monotonicFactory()` |
| zod | 4.6 | core, api, pos | |
| hono | 4.13 | api | |
| @hono/zod-validator | 0.9 | api | |
| drizzle-orm / drizzle-kit | 0.45 / 0.31 | db, api | typed D1 queries; drafts later migrations. `0001_init.sql` is hand-written from [02 §2](02-data-model.md#2-d1-schema-migration-0001_initsql) and is the source of truth (CHECKs, partial unique indexes); the Drizzle schema must mirror it, checked by `drizzle-kit generate` producing no diff in CI |
| wrangler | 4.152 | api | |
| @cloudflare/workers-types | 2026-10 | api | |
| papaparse | 5.7 | pos | CSV import/export |
| read-excel-file | 9.3 | pos | XLSX import (read only) |
| pdf-lib | 1.17 | pos | PDF report export |
| zxing-wasm | 3.1 | pos | camera barcode fallback |
| vitest | 5.0 | all | unit tests |
| @cloudflare/vitest-plugin | 1.4.8 | api | Worker + D1 integration tests (renamed from vitest-pool-workers; [D-055](decisions.md)) |
| fake-indexeddb | 6.2 | pos tests | Dexie in Node |
| @playwright/test | 1.64 | e2e | |

### 3.1 TypeScript 7 notes (decision D-024)

- Pin `"typescript": "7.0.2"` (exact) in the root `devDependencies`; `pnpm typecheck` = `tsc -b` (project references). TS 7.0 is the native Go port: same language, much faster `tsc`, but **7.0 ships no programmatic compiler API** (Microsoft expects a new API in 7.1).
- Tools in this stack that only *transpile* or run `tsc` as a CLI are unaffected: Vite (own transform pipeline, no type checking), Vitest, Biome (own parser; we use Biome, not ESLint), wrangler/esbuild, drizzle-kit, TanStack Router's route generator.
- If a tool ever needs to `import 'typescript'` (e.g. typescript-eslint, which as of Oct 2026 still declares `typescript <6.1`), do **not** downgrade: use Microsoft's side-by-side aliases and record it in `docs/decisions.md`:
  ```json
  "devDependencies": {
    "@typescript/native": "npm:typescript@7.0.2",
    "typescript": "npm:@typescript/typescript6@6.0.2"
  }
  ```
  After switching, delete `node_modules`, reinstall and confirm `pnpm exec tsc --version` prints `7.0.2`.
- tsconfig: `strict: true`, `module: "preserve"`, `moduleResolution: "bundler"`, `target: "es2024"`, `verbatimModuleSyntax: true`, `noUncheckedIndexedAccess: true`. Do not use options deprecated in TS 6.0 (e.g. `baseUrl`, `moduleResolution: "node"`/`"node10"`, `target: "es5"`, `outFile`); 7.0 removes them. Use `paths` relative to the tsconfig and pnpm workspace packages instead of `baseUrl`.
- Editors: use the workspace TypeScript version.

Fonts (self-hosted, precached): **Inter** (UI Latin, tabular numerals), **Noto Nastaliq Urdu** (Urdu UI and receipts), **JetBrains Mono** (receipt preview only). All are SIL OFL.

## 4. Repository layout

```
bikri/
├─ AGENTS.md  README.md  LICENSE
├─ package.json  pnpm-workspace.yaml  turbo.json  biome.json  .nvmrc
├─ .github/workflows/
│   ├─ ci.yml             lint, typecheck, unit, e2e (on PR)
│   ├─ deploy.yml         website check + build + wrangler deploy (on main)
│   ├─ website-guard.yml  nightly + manual: tools/check-website.mjs against the live algovyn.com
│   └─ backup.yml         nightly D1 export (cron)
├─ apps/
│   ├─ pos/               React PWA
│   │   ├─ index.html  vite.config.ts
│   │   ├─ public/        icons, fonts, manifest assets
│   │   └─ src/
│   │       ├─ main.tsx  app.tsx
│   │       ├─ routes/    one folder per screen (see docs/screens)
│   │       ├─ components/  shared UI (KeyBadge, MoneyInput, PinPad, Rail…)
│   │       ├─ data/      Dexie db, repositories (write row + outbox), live queries
│   │       ├─ sync/      push/pull engine, scheduler, status store
│   │       ├─ print/     printer service using packages/printer
│   │       ├─ scan/      HID listener, camera scanner
│   │       ├─ export/    CSV/PDF builders
│   │       ├─ i18n/      i18next init, direction handling
│   │       └─ state/     zustand stores (carts, session, ui)
│   └─ api/               Cloudflare Worker
│       ├─ wrangler.jsonc
│       └─ src/
│           ├─ index.ts   Hono app, routes mount, static asset fallthrough
│           ├─ middleware/  deviceAuth (sets tenant), shopAdmin, accessAuth, errors, rateLimit, tenantGate (status + quota)
│           ├─ db/        tenantDb.ts: the only way to query tenant tables (13 §5)
│           ├─ platform/  tenants, tenant_usage, operator console handlers
│           ├─ routes/    health, devices, sync (push, pull, snapshot), files, shop (shop admin), admin (operator)
│           ├─ sync/      applyOps, pull, snapshot, avgCost recompute
│           └─ cron/      prune.ts (scheduled(): per-tenant change_log floors, applied_ops retention, tenant deletion, 03 §4.4)
├─ packages/
│   ├─ core/              money.ts, totals.ts, refunds.ts, cost.ts, dayClose.ts, ledger.ts, stock.ts, schemas/
│   ├─ db/                drizzle schema (D1), migrations/*.sql, dexie.ts (Dexie schema), tables.ts (shared table metadata)
│   ├─ printer/           layout.ts, escpos.ts, raster.ts, templates/, transports/webusb.ts, transports/webserial.ts, labels/ (code128.ts, label layouts, screens/20)
│   └─ i18n/              en.json, ur.json, roman-ur.json, check-keys.ts
├─ tools/backup/          export.sh, encrypt.sh, tenant-extract.mjs (one tenant from a backup, 09 §3.4), README.md
├─ tools/check-website.mjs  go-live gate: no third-party scripts, no service worker on algovyn.com (§5.5)
├─ e2e/                   Playwright tests + fixtures
└─ docs/                  this specification
```

## 5. Worker and Hono

`apps/api/src/index.ts` creates one Hono app:

| Mount | Middleware | Purpose |
|---|---|---|
| `GET /bikri/api/health` | none | liveness, returns version and schema version |
| `/bikri/api/devices/enrol` | rate limit | exchange an enrolment code for a device token |
| `/bikri/api/me`, `/bikri/api/sync/*` (push, pull, snapshot), `/bikri/api/files/*` | `deviceAuth`, `tenantGate` | till API, scoped to the token's tenant |
| `/bikri/api/shop/*` | `deviceAuth`, `tenantGate`, `shopAdmin` | shop admin on admin devices ([05 §3](05-auth-and-roles.md#3-shop-admin-on-admin-devices)) |
| `/bikri/api/admin/*` | `sameOrigin`, `accessAuth` | platform operator console (Cloudflare Access JWT) |
| any other `/bikri/api/*` | — | `404 NOT_FOUND` JSON (never the SPA) |
| everything else under `/bikri/` | — | static assets (SPA); the Worker script does not run (`run_worker_first` covers only the API) |

The Hono app is created with `new Hono().basePath('/bikri/api')`, so route files declare `/health`, `/sync/push` etc. The Worker's default export is `{ fetch: app.fetch, scheduled }`; `scheduled()` runs the nightly prune ([03 §4.4](03-sync.md#44-retention-pruning-and-stale-tills)).

`deviceAuth`: reads `Authorization: Bearer <token>`, computes SHA-256, looks up `devices.token_hash` joined with `tenants` (one query), rejects if missing, `revoked_at` not null, or a support device past `expires_at` (`401 DEVICE_REVOKED`), sets `c.var.device` and **`c.var.tenant`** (id, status, db_shard, budget, restore_epoch). Nothing else in a till request can choose the tenant. Updates `devices.last_seen_at` at most once per 5 minutes (to save D1 writes).

`tenantGate`: `status` `suspended`/`deleting` → `403 TENANT_SUSPENDED`; `maintenance` → `503 MAINTENANCE`; `read_only` → reads and sign-in pass, writes of business data get `403 TENANT_READ_ONLY` (push applies only ops made before the device learned it, [13 §7.2](13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)); support devices may not push or upload (`403 FORBIDDEN`); on `/sync/push` also the daily write budget → `503 TENANT_QUOTA` ([13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)). Every `/me`, pull and push response carries `tenant_status` and `support`.

`shopAdmin`: requires `c.var.device.is_admin = 1`, `X-Bikri-Staff` naming an active `owner` of `c.var.tenant`, and (except the owner sign-in endpoints and ending support access) a valid `X-Bikri-Owner-Session` HMAC token for that tenant, device and owner ([05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082)).

`tenantDb(env, tenant)`: returns the D1 binding named by `tenant.db_shard` (v1 always `DB`) wrapped so that every statement binds `tenant_id` ([13 §5](13-multi-tenancy.md#5-tenant-scoping-rules-for-implementers)). Route code never touches `env.DB` for tenant tables.

`accessAuth`: verifies the `Cf-Access-Jwt-Assertion` header against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cache keys 1 h; on an unknown `kid` refetch once) with `aud = ACCESS_AUD`, `iss = https://<team>.cloudflareaccess.com`, `exp` in the future, and checks the email is in `OWNER_EMAILS` (v1 value: `adnan@yaqoob.org`, the only platform operator).

`sameOrigin`: for **every** `/bikri/api/admin/*` request, reject with `403 FORBIDDEN` when `Sec-Fetch-Site` is present and not `same-origin`; for all non-GET `/bikri/api/*` requests also reject unless the `Origin` header is `https://algovyn.com` (or the dev/preview origin from `ALLOWED_ORIGINS`). Device calls use a bearer token so CSRF is not possible there, but the operator API is authenticated by the Access cookie, so this check is required for it.

Errors: a single `onError` handler maps thrown `ApiError(code, status, message, details)` to the JSON error shape in [04-api §2](04-api.md#2-conventions). Zod failures become `VALIDATION_FAILED` (400).

CPU budget: the free plan allows **10 ms CPU per request**. Rules: no bcrypt/scrypt on the server; SHA-256 only via `crypto.subtle`; push handler processes at most 200 ops in one `db.batch()`; no image processing in the Worker (resize on the device).

### 5.1 `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "bikri",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "../pos/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/bikri/api/*"]
  },
  // Path routes on the existing algovyn.com zone (NOT a custom domain: that would take over the whole hostname)
  "routes": [
    { "pattern": "algovyn.com/bikri", "zone_name": "algovyn.com" },
    { "pattern": "algovyn.com/bikri/*", "zone_name": "algovyn.com" }
  ],
  "d1_databases": [
    // primary database: platform tables + every tenant in v1. Later shards (DB_2, …) are added here and named in tenants.db_shard (13 §4)
    { "binding": "DB", "database_name": "bikri", "database_id": "<filled by wrangler d1 create>", "migrations_dir": "../../packages/db/migrations" }
  ],
  "r2_buckets": [
    { "binding": "FILES", "bucket_name": "bikri-files" },     // till file API: keys t/<tenant_id>/products/… and t/<tenant_id>/shop/…
    { "binding": "BACKUPS", "bucket_name": "bikri-backups" }  // operator API only
  ],
  "vars": {
    "APP_VERSION": "0.1.0",
    "SCHEMA_VERSION": "1",
    "MIN_CLIENT_SCHEMA": "1",            // oldest till schema the push accepts (03 §4.1)
    "MAINTENANCE": "0",
    "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com", // from Zero Trust → Settings → Custom pages / team domain
    "BASE_PATH": "/bikri",
    "ALLOWED_ORIGINS": "https://algovyn.com",
    "SHOP_TIMEZONE": "Asia/Karachi"      // default only; each tenant's shop.timezone is authoritative
  },
  // owner email sign-in (05 §3.2): free sends to verified destination addresses, from the algovyn.com routing domain
  "send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["bikri@algovyn.com"] }],
  "ratelimits": [{ "name": "OWNER_SIGNIN_LIMIT", "namespace_id": "<unique integer per account>", "simple": { "limit": 10, "period": 60 } }],
  "triggers": { "crons": ["0 22 * * *"] },    // 03:00 Asia/Karachi: per-tenant prune + tenant deletion (03 §4.4); one trigger for all tenants; counts against the account's 5 free cron triggers
  "observability": { "enabled": true }
  // secrets (wrangler secret put): ACCESS_AUD, OWNER_EMAILS (= "adnan@yaqoob.org", the platform operator),
  // OWNER_CODE_KEY and OWNER_SESSION_KEY (32 random bytes each, owner email sign-in, 05 §3.2)
}
```

Asset layout: `apps/pos` builds into `apps/pos/dist/bikri/` (Vite `base: '/bikri/'`, `outDir: 'dist/bikri'`) and wrangler's `assets.directory` is `apps/pos/dist`. Cloudflare requires the asset directory to **mirror the public path** when a Worker with assets runs on a path route ("Serving a subdirectory" in the Workers static-assets docs), so `/bikri/assets/index-abc.js` is the file `dist/bikri/assets/index-abc.js`. A post-build step copies `dist/bikri/index.html` to `dist/index.html` as well, so the SPA fallback returns the app shell for deep links such as `/bikri/sales/01JC…` whichever `index.html` the asset server picks; asset URLs inside it are absolute (`/bikri/…`), so both copies work. T-002 must verify deep-link reloads and `/bikri` → `/bikri/` with `wrangler dev`. (A newer `assets.base_path` option is being added to wrangler; only switch to it once it is in a released wrangler version, and record the change in decisions.)

### 5.2 Security headers

API responses get them from a Hono middleware. Static assets get them from a Workers-assets `_headers` file, which must sit at the **root of the assets directory** (`apps/pos/dist/_headers`, written by the post-build step, rules for `/bikri/*`), not inside `dist/bikri/` (Vite would put `public/_headers` there). T-002 checks with `curl -sI https://algovyn.com/bikri/` that CSP and HSTS are present on the HTML:

```
Strict-Transport-Security: max-age=31536000
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'
Cache-Control: public, max-age=0, must-revalidate, no-transform
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Permissions-Policy: camera=(self), usb=(self), serial=(self), bluetooth=()
```

`'wasm-unsafe-eval'` is required because the camera barcode fallback (`zxing-wasm`) compiles WebAssembly; without it Chrome blocks `WebAssembly.instantiate` under `default-src 'self'`. Self-host the `.wasm` file (no CDN).

`no-transform` is required too: Cloudflare Web Analytics injects `static.cloudflareinsights.com/beacon.min.js` into proxied HTML unless the response says not to transform it. The CSP would block the script, but the browser still requests it and logs a violation. `no-transform` keeps the app free of third-party scripts (D-131).

These headers apply only to responses under `/bikri/`. HSTS deliberately omits `includeSubDomains`, because it would be sent for the whole `algovyn.com` domain and force HTTPS on every Algovyn subdomain; add it only if the owner confirms all subdomains are HTTPS.

### 5.3 Coexisting with the Algovyn website on `algovyn.com`

Checked on 27 Oct 2026: `https://algovyn.com/` is the Algovyn marketing site, served through Cloudflare (static HTML; the `AlgoVyn/website` repo has no wrangler config, so it is most likely a Cloudflare Pages project or another Cloudflare-proxied origin — confirm in the dashboard). `https://algovyn.com/bikri` currently returns `404`, so the path is free and nothing clashes.

- Bikri uses **Worker routes** (`algovyn.com/bikri` and `algovyn.com/bikri/*`), never a Workers Custom Domain, because a custom domain would take over the whole `algovyn.com` hostname.
- When a request matches a Worker route, the Worker runs and serves the response; the website (Pages project or origin) only receives requests that match no route. When several route patterns match, the most specific one wins (Cloudflare Workers "Routes" docs), so a future catch-all such as `algovyn.com/*` would still lose to `algovyn.com/bikri/*`.
- Two precise patterns are used instead of `algovyn.com/bikri*`: the single-wildcard form would also capture unrelated website paths such as `/bikri-guide` or `/bikrishop`.
- The apex DNS record for `algovyn.com` must stay proxied (orange cloud) — it already is, since the site is served by Cloudflare. No DNS change is needed for Bikri.
- After the first deploy, check: `curl -sI https://algovyn.com/` (website unchanged), `curl -s https://algovyn.com/bikri/api/health` (Bikri JSON), `curl -sI https://algovyn.com/bikri` (a redirect to `/bikri/` from the asset server).

### 5.4 Same origin as the website: storage, permissions, cookies, CORS

Path-based hosting means Bikri and the Algovyn website share **one browser origin, `https://algovyn.com`**. Consequences the implementation must respect (decision D-026):

- **Website service worker:** the live website registers no service worker (checked 27 Oct 2026). It must never register one whose scope covers `/bikri/` (a site SW at `/` would intercept Bikri's requests). Enforced by the release gate in §5.5.
- **Storage is per origin, not per path.** IndexedDB, Cache Storage, `localStorage` and the `navigator.storage.persist()` grant are shared with every page on `algovyn.com`. Prefix every Bikri store: Dexie DB names `bikri-<tenant_id>` (one per shop, D-073) and the pointer `localStorage['bikri.active_tenant']`, Workbox cache names `bikri-*` (`cacheId: 'bikri'`). Never clear origin-wide storage (no `caches.keys()` deletes without the `bikri-` prefix, no Clear-Site-Data header).
- **Any script on any `algovyn.com` page can read Bikri's IndexedDB**, including the device tokens of every shop enrolled in that browser. Therefore: Bikri loads no third-party scripts (CSP `default-src 'self'`), and the Algovyn website should not load third-party JavaScript either. Note: as of 27 Oct 2026 the live site HTML still loads `<script src="https://cdn.tailwindcss.com">` and Google Fonts, while the `website` repo has already switched to a built `tailwind.css` — deploy that change before Bikri goes live (the release gate in §5.5 fails until then). If the website ever needs third-party JS, move Bikri to a subdomain (a new decision).
- **WebUSB / Web Serial permissions** are granted per origin; a printer granted to Bikri is also visible to other pages on `algovyn.com`. Same mitigation as above.
- **Secure context:** `https://algovyn.com` is HTTPS, so service workers, WebCrypto, WebUSB and Web Serial (all require a secure context) work. `http://localhost` is also a secure context for development.
- **Cookies:** Bikri sets no cookies of its own (device token lives in IndexedDB, sent as a bearer header). If a cookie is ever added it must use `Path=/bikri; Secure; HttpOnly; SameSite=Strict`. Cloudflare Access sets its own `CF_Authorization` cookie for the protected admin paths; Bikri only reads the `Cf-Access-Jwt-Assertion` header.
- **CORS:** the app and API are the same origin, so no CORS headers are sent and no preflights happen. The API never returns `Access-Control-Allow-Origin`. Non-GET requests must pass the `sameOrigin` check (§5).

### 5.5 Release gate: a clean `algovyn.com` (decision D-049)

Keeping Bikri on `algovyn.com/bikri` is safe only while **no page on `algovyn.com` loads third-party scripts and no service worker is registered outside `/bikri/`**. This is a go-live requirement, checked automatically by `tools/check-website.mjs` (Node 24, no dependencies):

1. Collect pages: `https://algovyn.com/`, every `<loc>` in `https://algovyn.com/sitemap.xml` on the same host (today `/`, `/smartgrind`, `/marksocial`), and every same-host link on the home page (max 50 pages; `/bikri/` excluded).
2. For each page (and each same-origin `.js` file it loads): **fail** on any `<script src>` whose host is not `algovyn.com` (including protocol-relative `//…`), any `import()`/`importScripts()` of another host, any `<script>` with `type="module"` importing another host, and any text `serviceWorker.register` outside `/bikri/`.
3. **Fail** if `/sw.js`, `/service-worker.js`, `/serviceworker.js` or `/worker.js` at the site root returns `200` with a JavaScript content type.
4. **Warn** (do not fail) on third-party stylesheets and fonts (e.g. Google Fonts): they cannot run code, but self-hosting them is still recommended.
5. Print a table of findings; exit code 1 on any failure.

Where it runs:
- `deploy.yml` runs it **before** `wrangler deploy`; a failure stops the deploy (override only with the manual input `skip_website_check: true`, which is logged in the run summary).
- `website-guard.yml` runs it nightly and on demand; a failure fails the workflow, so GitHub emails the owner. The website repo should run the same script in its own CI (copy or `npx`), so a website change cannot silently break Bikri's isolation.
- The [go-live checklist](09-backups-and-ops.md#7-go-live-checklist) and release task T-065 require a passing run.

Status on 27 Oct 2026: **fails** (`https://cdn.tailwindcss.com` script on `/`); no service worker found.

## 6. PWA

- `vite-plugin-pwa` with `generateSW`, `base: '/bikri/'`, `scope: '/bikri/'`, `filename: 'sw.js'` (served at `/bikri/sw.js`, so its scope can never cover the website), `workbox.cacheId: 'bikri'`, `navigateFallback: '/bikri/index.html'`, `navigateFallbackDenylist: [/^\/bikri\/api\//, /^\/bikri\/admin/]`: precache all build assets, fonts and icons; no Workbox runtime route for `/bikri/api/files/*`: the service worker cannot add the device `Authorization` header. Instead `apps/pos/src/data/fileCache.ts` fetches files with the bearer token and stores the responses in Cache Storage `bikri-files` (cache-first, max 2,000 entries, LRU); images render from object URLs, so photos work offline.
- No Background Sync in v1 (`generateSW` cannot read the Dexie outbox); tills push while the app is open ([03 §6](03-sync.md#6-scheduling)).
- `registerType: 'prompt'`: when a new version is available, the rail shows "Update ready"; the app reloads only when no cart has items and no dialog is open, or when the user taps it. Never reload mid-sale.
- Manifest (`/bikri/manifest.webmanifest`): `id: "/bikri/"`, `name: "Bikri POS"`, `short_name: "Bikri"`, `display: "standalone"`, `start_url: "/bikri/"`, `scope: "/bikri/"`, `theme_color: "#006BB3"` (Algovyn blue, doc 08), `background_color: "#F8FAFC"`, `orientation: "any"`, icons 192/512 + maskable (paths under `/bikri/`). The website's own manifest (`scope: "/"`) is separate; the two installed apps do not conflict because Bikri's `id`/`scope` are `/bikri/`.
- On first run call `navigator.storage.persist()`; show a warning banner in Settings → Backup if it returns `false`.
- Supported browsers: Chrome/Edge ≥ 120 on Windows 10/11 and Android 10+ (full features). Safari/Firefox: selling and reports work; hardware printing falls back to browser print; no WebUSB/Web Serial.

## 7. Deployment

### 7.1 One-time setup (platform operator)

1. `wrangler d1 create bikri` → put `database_id` in `wrangler.jsonc`.
2. `wrangler r2 bucket create bikri-files` and `wrangler r2 bucket create bikri-backups`.
3. `algovyn.com` is already an active, proxied Cloudflare zone (the website). No DNS change: `wrangler deploy` creates the two Worker routes `algovyn.com/bikri` and `algovyn.com/bikri/*` (§5.3). Do **not** add a Custom Domain.
4. Zero Trust → Access → Applications → Add → Self-hosted, name "Bikri admin" (the platform operator console). Destinations (public hostnames): `algovyn.com` path `bikri/admin`, `algovyn.com` path `bikri/admin/*`, `algovyn.com` path `bikri/api/admin`, `algovyn.com` path `bikri/api/admin/*` (Access path wildcards do not cover the parent path, so both forms are listed). Policy "Allow", Include → Emails → `adnan@yaqoob.org` (the only operator). Login method One-time PIN; session 24 h. Nothing else on `algovyn.com` is put behind Access. Copy the **AUD tag** → `wrangler secret put ACCESS_AUD`; `wrangler secret put OWNER_EMAILS` → `adnan@yaqoob.org`. The Worker's `accessAuth` check is authoritative regardless of how Access matched the path.
5. Check `wrangler d1 migrations list bikri --remote` shows nothing applied (M0 schema was single-shop and is rewritten in place, D-077), then `wrangler d1 migrations apply bikri --remote`.
6. GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (Workers, D1, R2 edit), `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_AGE_RECIPIENT` (the operator's age public key); repository variable `DEPLOY_ENABLED` = `true`; make the `ci` check required on `main` (branch protection).
7. After the first deploy: create the first tenant (the operator's own shop) in the console and enrol its first device with the owner pairing code ([13 §7.1](13-multi-tenancy.md#71-onboarding-a-new-shop-d-072)).
8. Owner email sign-in: `wrangler secret put OWNER_CODE_KEY` and `OWNER_SESSION_KEY` (e.g. `openssl rand -base64 32`). For each shop owner's email: Cloudflare dashboard → Email Service → Email Routing → Destination addresses → add it; the owner clicks Cloudflare's verification email once. `algovyn.com` is already an Email Routing domain, so no DNS change is needed ([05 §3.2](05-auth-and-roles.md#32-owner-email-sign-in-d-082)).

### 7.2 CI/CD

- `ci.yml` (PR): `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → build → Playwright against `wrangler dev` with local D1.
- `deploy.yml` (successful `ci` workflow_run for `main`): `node tools/check-website.mjs` (§5.5) → build `apps/pos` → `wrangler d1 migrations apply bikri --remote` → `wrangler deploy` → smoke test. The deploy job runs only when the repository variable `DEPLOY_ENABLED` is `true` (set after §7.1) and refuses the placeholder `database_id`; the website check runs on every push to `main` regardless (D-060). A preview environment (`bikri-preview`, separate D1 `bikri-preview`, URL `https://bikri-preview.<account>.workers.dev/bikri/`, no routes on `algovyn.com`) deploys on PRs with label `preview`; its origin is added to `ALLOWED_ORIGINS` for that environment only.
- Migrations live in `packages/db/migrations/000N_<name>.sql` (the `migrations_dir` in `wrangler.jsonc`). They must stay backward compatible with tills running the previous app version for at least **14 days** (add columns nullable or with defaults; never rename/drop in v1), because tills may run the old cached app for a while. Bump `SCHEMA_VERSION` when a migration changes columns or the wire shape; index-only migrations (e.g. T-062's `0003_perf_indexes.sql`) do not need a client version bump. Raise `MIN_CLIENT_SCHEMA` only for a breaking change ([03 §4.1](03-sync.md#41-push--post-apisyncpush)). Dexie schema versions are bumped in the same PR (`db.version(n).stores(...)` with an `upgrade()` when local data must change).

## 8. Cloudflare free-tier budget

Limits read from Cloudflare docs on 27 Oct 2026 (sources in [13 §2](13-multi-tenancy.md#2-cloudflare-facts-the-decision-rests-on-checked-27-oct-2026)). The row and request limits are **per account**, shared by every shop on the deployment and by the other Algovyn Workers; the per-shop budget, the number of shops that fit and how the daily limits are shared are in [13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop). Volume assumption per shop: 2 tills, 13 h/day open, 150 bills/day, 3 lines/bill.

| Resource | Free limit | Per reference shop | Notes |
|---|---|---|---|
| Worker requests | 100,000/day per account (reset 00:00 UTC) | ~1,560 pulls (60 s × 2 tills × 13 h) + ~300 pushes + ~200 file/other ≈ 2,100/day | ≈ 33 shops at 70 % of the limit |
| Worker CPU | 10 ms per request | push of 200 ops ≈ 2–5 ms | watch |
| Worker subrequests | 50/request (1,000 to internal services) | 1 D1 batch + ≤ 2 R2 calls | fine |
| D1 rows written | 100,000/day per account | ≈ 17,550/day (T-062 measured 117/bill for 150 reference bills incl. indexes and sync) | **≈ 4 shops** at the 70 % share |
| D1 rows read | 5,000,000/day per account | indexed pulls ≈ 25,000/day | > 100 shops |
| D1 DB size | 500 MB per DB, 10 DBs and 5 GB per account | ≈ 153 MB/year (T-062 measured 1.9 KB/bill) | ≈ 3.3 shop-years per database, then a shard or Workers Paid |
| D1 queries per Worker invocation | 50 | `db.batch()` counts as 1 | fine |
| D1 Time Travel | 7 days, whole database | disaster recovery only (rolls back every shop) | per-shop restore is logical ([09 §3.4](09-backups-and-ops.md#34-restore-one-tenant)) |
| Cron triggers | 5 per account (shared by all Workers on the account), 10 ms CPU each | 1 for all shops (nightly prune + tenant deletion, [03 §4.4](03-sync.md#44-retention-pruning-and-stale-tills)); backups run in GitHub Actions | check other Algovyn Workers use ≤ 4 |
| R2 | 10 GB-month, 1M Class A, 10M Class B per month | ≈ 25 MB photos; daily dumps shared | fine |
| Static assets | 20,000 files, 25 MiB each | ~150 files | fine |
| Cloudflare Access | 50 users | 1 operator | fine |
| Email (owner sign-in codes) | Free: only to verified destination addresses, free and unmetered; 200 addresses per account | 1 address per shop, a few codes a week | fine; arbitrary recipients need Workers Paid ([13 §2](13-multi-tenancy.md#2-cloudflare-facts-the-decision-rests-on-checked-27-oct-2026)) |

Rules that keep usage low:
- Reports and lists are computed on the device from IndexedDB, never from D1.
- Pull only when the app is visible (`document.visibilityState === 'visible'`), every `poll_after_ms` (default 60 s, per tenant), plus immediately after a push.
- `devices.last_seen_at` updated at most every 5 minutes.
- Every query uses an index that starts with `tenant_id`, so one shop's queries never scan other shops' rows (D1 bills rows scanned).
- Per-tenant daily write budget with `503 TENANT_QUOTA` ([13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)). If the account limit itself is hit, D1 returns errors until 00:00 UTC (05:00 PKT) for every shop; tills keep selling offline and sync later. Upgrade path: Workers Paid, USD 5/month.
