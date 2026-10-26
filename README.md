# Bikri POS

Bikri (Urdu: بکری, "sale") is an open-source, offline-first point-of-sale web app for small shops in Pakistan. It is being built first for one cash-heavy electronics shop, and is designed so the owner keeps full control of the code and the data.

- **Sell fast:** scan or tap items, take cash/card/wallet/udhaar, print an ESC/POS thermal receipt, open the cash drawer.
- **Works offline:** every sale is saved in the browser first (IndexedDB) and synced to Cloudflare D1 when online.
- **Udhaar khata:** customer credit with limits, part payments, promises, chase list and WhatsApp reminders.
- **Stock and suppliers:** deliveries, returns to supplier, supplier ledger, stock adjustments with reasons, weighted-average cost, Code 128 barcode labels printed from the browser.
- **Day close and reports:** a cash drawer reconciliation that counts every cash movement; reports with CSV/PDF export.
- **English, Urdu (RTL) and Roman Urdu.**
- **Hosting:** one Cloudflare Worker (Hono API + static PWA), D1 and R2, on the Cloudflare free tier. URL: **`https://algovyn.com/bikri/`** (path-based on the existing Algovyn domain); owner admin behind Cloudflare Access for `adnan@yaqoob.org`.

- **Printing:** printer-agnostic ESC/POS over WebUSB or Web Serial, 58 mm or 80 mm, with browser-print fallback.
- **Look:** Algovyn brand colours (blue `#006BB3`, navy `#182E55`, teal `#4BC2BF`), Inter.
- **Tooling:** TypeScript 7.0.2, pnpm, Turborepo, Biome.

## Status

Design phase. The full implementation-ready specification lives in [`docs/`](docs/00-overview.md). AI coding agents start at [`AGENTS.md`](AGENTS.md).

The Dukaan POS reference screenshots in `docs/reference/dukaan/` are **local-only**: the folder is gitignored (third-party UI, and one screenshot set came from a real account), so links to them work only in the local checkout where they were captured, not on GitHub.

## Repository layout (target)

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
