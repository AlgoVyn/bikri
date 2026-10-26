# AGENTS.md — How to build Bikri from these docs

This file is the entry point for any AI coding agent (or human) implementing Bikri. Read it fully before writing code.

## 1. What you are building

An offline-first POS PWA for a single shop (with optional extra branches and tills), deployed as **one Cloudflare Worker** that serves the static React app and a Hono JSON API, backed by **D1** (SQLite) and **R2** (files). Each till keeps a full local copy of the shop's data in **IndexedDB via Dexie** and works with no network. See [docs/00-overview.md](docs/00-overview.md) and [docs/01-architecture.md](docs/01-architecture.md).

## 2. Document map (read in this order)

| # | Doc | Use it for |
|---|-----|-----------|
| 0 | [00-overview](docs/00-overview.md) | Scope, non-goals, glossary, the numbered **requirements** (`REQ-…`) |
| 1 | [01-architecture](docs/01-architecture.md) | Stack, versions, repo layout, Cloudflare config, deployment |
| 2 | [02-data-model](docs/02-data-model.md) | Exact D1 SQL and Dexie schema. **Source of truth for every column name.** |
| 3 | [03-sync](docs/03-sync.md) | Outbox, push/pull, conflict rules, idempotency |
| 4 | [04-api](docs/04-api.md) | Every endpoint, JSON shapes, error codes, Zod schemas |
| 5 | [05-auth-and-roles](docs/05-auth-and-roles.md) | Device tokens, PINs, roles and the permission matrix |
| 6 | [06-printing](docs/06-printing.md) | ESC/POS bytes, receipt templates, WebUSB/Web Serial, fallback |
| 7 | [07-money-rules](docs/07-money-rules.md) | Totals, discounts, tax, rounding, refunds, cost, day close + **test vectors** |
| 8 | [08-ux-guidelines](docs/08-ux-guidelines.md) | Tokens, typography, i18n/RTL, accessibility, global hotkeys |
| 9 | [09-backups-and-ops](docs/09-backups-and-ops.md) | Backups, restore, monitoring, free-tier budgets |
| 10 | [10-testing](docs/10-testing.md) | Unit, integration and Playwright e2e plan, fixtures |
| 11 | [11-roadmap](docs/11-roadmap.md) | **Ordered task list with acceptance criteria — your build plan** |
| 12 | [12-fbr-later](docs/12-fbr-later.md) | Optional FBR module (do not build in v1) |
| — | [fixtures/](docs/fixtures/money-totals.json) | Machine-readable test vectors: money (`money-*.json`) used by `packages/core` tests, and Code 128 (`barcode-code128.json`) used by `packages/printer` |
| — | [decisions](docs/decisions.md) | Design decisions log — append here when you resolve an unclear point |
| — | [screens/](docs/screens/README.md) | One spec per screen: layout, fields, validation, states, hotkeys, acceptance criteria |
| — | [reference/dukaan/](docs/reference/dukaan/README.md) | Screenshots of a third-party product used **only** as UX reference. **Local-only:** gitignored, so these links work only in the owner's local checkout; in a fresh clone they are missing — rely on the screen specs, which are complete on their own |

## 3. Build order

Follow [docs/11-roadmap.md](docs/11-roadmap.md) task by task (T-001, T-002, …). Do not start a task until the previous milestone's acceptance criteria pass. In short:

1. Monorepo scaffold, tooling, CI, deploy a hello-world Worker with static assets.
2. `packages/core` money rules with all test vectors from doc 07 passing **before any UI**.
3. `packages/db`: D1 migrations + Dexie schema from doc 02.
4. Worker API skeleton: auth middleware, sync push/pull, enrolment (docs 03–05).
5. PWA shell: enrolment, setup wizard, PIN lock, rail, Home.
6. Catalogue → Sell → Pay → Printing → Refunds → Udhaar → Sync hardening → Suppliers/Stock → Expenses/Day close/Reports → Languages/Backups.

## 4. Conventions (mandatory)

**Language and tooling**
- TypeScript **7.0.2** (exact pin; see [01 §3.1](docs/01-architecture.md#31-typescript-7-notes-decision-d-024) for the TS 6 side-by-side alias if a tool needs the compiler API) everywhere, `strict: true`, no `any` (use `unknown` + Zod parsing at boundaries).
- pnpm workspaces + Turborepo. Biome for lint and format (no ESLint/Prettier).
- ES modules only. Node 24 LTS for tooling.

**URLs (Bikri is served at `https://algovyn.com/bikri/`)**
- Never hard-code `/bikri`: use `BASE_PATH` / `API_BASE` from `packages/core/src/paths.ts`, Vite `base`, and the router `basepath` ([01 §1.1](docs/01-architecture.md#11-url-layout-and-the-path-convention-used-in-these-docs)). Routes and API paths in the docs are relative to `/bikri`.
- Bikri shares the `algovyn.com` origin with the Algovyn website: prefix all storage (`bikri` Dexie DB, `bikri-*` caches), never clear origin-wide storage, load no third-party scripts ([01 §5.4](docs/01-architecture.md#54-same-origin-as-the-website-storage-permissions-cookies-cors)).

**Look and printing**
- Use only the Algovyn-based tokens in [doc 08](docs/08-ux-guidelines.md); no raw hex in components.
- Printing is printer-agnostic (WebUSB + Web Serial + browser print, 58/80 mm); never add vendor-specific code ([06 §0](docs/06-printing.md#0-printer-agnostic-design-decision-d-023)).

**Money and numbers**
- Money is **integer paisa** (`number`, always an integer; 1 rupee = 100 paisa). Never use floats for money. Column and field names end in `_paisa` only where ambiguity exists; all `amount`, `price`, `total` fields are paisa.
- Quantities are **integer milli-units** (`qty_milli`, 1 piece = 1000).
- Percentages are **basis points** (`*_bp`, 1% = 100 bp).
- All money arithmetic goes through `packages/core/money.ts` helpers (`mulDivRound`, `allocate`, `roundTo`). Never inline `Math.round(a * b / c)` in UI code.

**IDs and time**
- Every row ID is a **ULID** string generated on the client (`ulidx` with monotonic factory).
- Timestamps are **integer epoch milliseconds UTC**. Business dates (day close, reports) use the shop time zone (`shop.timezone`, default `Asia/Karachi`).

**Data rules**
- Money and stock records are **append-only**: `sales`, `sale_lines`, `payments`, `refunds`, `refund_lines`, `ledger_entries`, `stock_movements`, `purchases`, `purchase_lines`, `expenses`, `cash_moves`, `day_closes`, `audit_log`. Never UPDATE or DELETE them; correct with a new row (refund, void, reversal, adjustment). The only allowed update on `sales` is the `status` field via a refund/void op.
- Stock on hand and party balances are **derived** (sums), never edited directly.
- Soft delete (`deleted_at`) for master data. Never hard-delete.
- Every write on the till goes through a repository function in `apps/pos/src/data/` that writes the row(s) **and** the matching outbox ops in one Dexie transaction.

**Code organisation**
- Business rules live in `packages/core` as pure functions with unit tests. React components never compute totals, tax, cost or balances themselves.
- Shared Zod schemas live in `packages/core/schemas`. The Worker validates every request with them; the client validates every pulled row with them.
- UI strings never hard-coded: every visible string is an i18n key present in `en.json`, `ur.json` and `roman-ur.json` (CI fails otherwise).
- Use CSS logical properties (`ms-*`, `pe-*`, `start`, `end`) so RTL works without special cases.

**Git**
- Conventional commits (`feat(sell): …`, `fix(core): …`). One roadmap task per PR where possible; PR title includes the task ID (e.g. `T-031`).

## 5. Definition of done (every task)

A task is done only when **all** of these hold:

1. The task's acceptance criteria in [11-roadmap](docs/11-roadmap.md) and the referenced screen spec pass.
2. `pnpm lint`, `pnpm typecheck`, `pnpm test` pass locally and in CI.
3. New business logic has unit tests; any money rule touched still passes every vector in doc 07.
4. New screens have a Playwright test for the happy path in **English and Urdu** at 1280×800 and 390×844.
5. No hard-coded strings; all three locale files contain the new keys.
6. Works offline: the feature is usable with the network disabled (Playwright `context.setOffline(true)`), and syncs correctly after reconnecting, where relevant.
7. Hotkeys listed in the screen spec work and are shown as key badges.
8. Docs updated if behaviour differs from the spec (update the spec in the same PR and say why).

## 6. Things you must not do

- Do not copy Dukaan POS code, assets, icons, text or visual identity. Its screenshots are a **behavioural/UX reference only** (see [reference README](docs/reference/dukaan/README.md)). Bikri uses the Algovyn brand tokens in doc 08.
- Do not decompile, unpack or inspect any third-party binaries or bundles.
- Do not add third-party analytics, ads or tracking scripts.
- Do not put Cloudflare Access in front of the till (it breaks offline) or the rest of `algovyn.com`; only `/bikri/admin*` and `/bikri/api/admin/*`, allowed email `operator@example.com`.
- Do not use a Workers Custom Domain for `algovyn.com` (it would replace the website); use the two Worker routes in [01 §5.1](docs/01-architecture.md#51-wranglerjsonc).
- Do not store secrets in the repo. Use `wrangler secret put` and GitHub Actions secrets.
- Do not build FBR integration, batches/expiry or multi-currency in v1.

## 7. When the spec is unclear

Prefer, in order: (1) the data model doc, (2) the money rules doc, (3) the screen spec, (4) this file. If still unclear, choose the simplest behaviour that keeps data append-only and offline-safe, implement it, and record the decision in `docs/decisions.md` (create it) with date and reasoning.
