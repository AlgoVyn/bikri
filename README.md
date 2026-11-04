# Bikri POS

Bikri (Urdu: بکری, "sale") is an open-source, offline-first point-of-sale PWA. It runs many independent shops on one Cloudflare deployment; every shop's data is isolated and can be exported at any time.

**Live:** <https://algovyn.com/bikri/>

## Features

- **Sell fast** — scan or tap items, take cash/card/wallet/udhaar, print ESC/POS receipts and open the cash drawer.
- **Offline first** — every till keeps a full IndexedDB copy and syncs through an outbox when online.
- **Udhaar khata** — customer credit with limits, part payments, promises, a chase list and WhatsApp reminders.
- **Stock and suppliers** — deliveries, supplier returns and ledger, stock adjustments, weighted-average cost and Code 128 labels.
- **Day close and reports** — cash-drawer reconciliation and CSV/PDF exports.
- **Three languages** — English, Urdu (RTL) and Roman Urdu.
- **Printer-agnostic** — WebUSB, Web Serial or browser print; 58 mm and 80 mm.

## Stack

React + Vite PWA · Hono on Cloudflare Workers · D1 · R2 · Dexie · TypeScript · pnpm + Turborepo · Biome.

## Status

v1.0.0 release candidate. See [CHANGELOG.md](CHANGELOG.md) and the [roadmap](docs/11-roadmap.md). The specification lives in [`docs/`](docs/00-overview.md); coding agents start at [`AGENTS.md`](AGENTS.md).

## Quick start

Requires Node 24 (`.nvmrc`) and pnpm 12 (`corepack enable`).

```sh
pnpm install

# terminal 1: API + local D1, built till at http://localhost:8787/bikri/
pnpm --filter @bikri/api dev

# terminal 2: Vite with hot reload at http://localhost:5173/bikri/
pnpm dev
```

Build and checks:

```sh
pnpm build
pnpm lint && pnpm typecheck && pnpm test
pnpm e2e   # first: pnpm --filter @bikri/e2e exec playwright install chromium
pnpm i18n:check && pnpm contrast:check && pnpm docs:check && pnpm size
```

## Repository layout

| Path | Purpose |
|---|---|
| `apps/pos` | React + Vite PWA: till and back office |
| `apps/api` | Cloudflare Worker: Hono API + static assets |
| `packages/core` | Pure business and money rules, shared table/op metadata |
| `packages/db` | D1 SQL migrations, Dexie schema, table metadata |
| `packages/printer` | Receipt layout, ESC/POS encoder, raster renderer, transports |
| `packages/i18n` | `en`, `ur` and `roman-ur` translation catalogs |
| `tools/` | Backup, check and performance tooling |
| `docs/` | Product and engineering specification |

## Documentation

- [Operator guide](docs/operator-guide.md) — deploy and run the service.
- [Owner guide](docs/owner-guide.md) — set up a shop and use the till.
- [Architecture](docs/01-architecture.md) · [Data model](docs/02-data-model.md) · [Sync](docs/03-sync.md) · [API](docs/04-api.md)
- [Money rules](docs/07-money-rules.md) · [Testing](docs/10-testing.md) · [Multi-tenancy](docs/13-multi-tenancy.md)

## License

MIT — see [LICENSE](LICENSE).
