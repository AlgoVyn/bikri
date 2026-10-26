# Bikri POS

Bikri (Urdu: بکری, "sale") is an open-source, offline-first point-of-sale web app for small shops in Pakistan. It is being built first for one cash-heavy electronics shop and runs many independent shops on one deployment, operated by Algovyn; each shop's data is isolated from every other shop and can be exported at any time.

- **Sell fast:** scan or tap items, take cash/card/wallet/udhaar, print an ESC/POS thermal receipt, open the cash drawer.
- **Works offline:** every sale is saved in the browser first (IndexedDB) and synced to Cloudflare D1 when online.
- **Udhaar khata:** customer credit with limits, part payments, promises, chase list and WhatsApp reminders.
- **Stock and suppliers:** deliveries, returns to supplier, supplier ledger, stock adjustments with reasons, weighted-average cost, Code 128 barcode labels printed from the browser.
- **Day close and reports:** a cash drawer reconciliation that counts every cash movement; reports with CSV/PDF export.
- **English, Urdu (RTL) and Roman Urdu.**
- **Hosting:** one Cloudflare Worker (Hono API + static PWA), D1 and R2, on the Cloudflare free tier. URL: **`https://algovyn.com/bikri/`** (path-based on the existing Algovyn domain).
- **Multi-tenant:** many independent shops share one deployment and one D1 database, every row scoped by `tenant_id` and never visible to another shop; the platform operator console sits behind Cloudflare Access for `operator@example.com`, and shop owners manage their own devices from admin devices ([docs/13](docs/13-multi-tenancy.md)).

- **Printing:** printer-agnostic ESC/POS over WebUSB or Web Serial, 58 mm or 80 mm, with browser-print fallback.
- **Look:** Algovyn brand colours (blue `#006BB3`, navy `#182E55`, teal `#4BC2BF`), Inter.
- **Tooling:** TypeScript 7.0.2, pnpm, Turborepo, Biome.

## Status

**M0 Foundations** (T-001–T-007) implemented: monorepo, Worker + static assets at `/bikri/`, D1 migrations, CI/CD workflows, PWA shell, Algovyn design tokens + UI kit, i18n. Next: M1 Local till (T-010 onward, see [roadmap](docs/11-roadmap.md)). The full implementation-ready specification lives in [`docs/`](docs/00-overview.md). AI coding agents start at [`AGENTS.md`](AGENTS.md).

The Dukaan POS reference screenshots in `docs/reference/dukaan/` are **local-only**: the folder is gitignored (third-party UI, and one screenshot set came from a real account), so links to them work only in the local checkout where they were captured, not on GitHub.

## Development

Requires Node 24 (`.nvmrc`) and pnpm 12 (`corepack enable`).

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # Biome, tsc -b (TS 7), Vitest (incl. Worker + D1 in Miniflare)
pnpm build                                   # apps/pos → apps/pos/dist/bikri (+ dist/index.html, dist/_headers)
pnpm --filter @bikri/api dev                 # build + local D1 migrations + wrangler dev → http://localhost:8787/bikri/
pnpm dev                                     # Vite dev server → http://localhost:5173/bikri/ (proxies /bikri/api to :8787)
pnpm e2e                                     # Playwright against wrangler dev (first: pnpm --filter @bikri/e2e exec playwright install chromium)
pnpm i18n:check && pnpm contrast:check && pnpm docs:check && pnpm size
pnpm website:check                           # go-live gate for algovyn.com (01 §5.5)
```

CI/CD workflows live in `.github/workflows/` (`ci`, `deploy`, `website-guard`). Nothing deploys until the one-time Cloudflare setup in [01 §7.1](docs/01-architecture.md#71-one-time-setup-platform-operator) is done and the repository variable `DEPLOY_ENABLED=true` is set (D-060).

## Repository layout

```
apps/pos          React + Vite PWA (the till and back office)
apps/api          Cloudflare Worker: Hono API + static assets
packages/core     Pure TypeScript business and money rules, Zod schemas
packages/db       Drizzle schema + SQL migrations for D1, Dexie schema
packages/printer  Receipt layout, ESC/POS encoder, raster renderer, transports
packages/i18n     en / ur / roman-ur translation files
tools/backup      Nightly D1 export workflow
docs/             This specification
```

## License

MIT — see [LICENSE](LICENSE).
