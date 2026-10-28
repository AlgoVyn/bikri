# 08 — UX guidelines

Bikri has its **own** visual identity. Dukaan screenshots show behaviour only; do not copy their colours, layout proportions, icons, illustrations or copy.

## 1. Principles

1. **Speed over decoration.** The cashier is standing with a customer. Every sale must be possible with keyboard + scanner only, and with one thumb on a phone.
2. **Never lose money data.** Save first, then print/share. Show what was saved.
3. **Warn, don't block** (stock, credit limit) — block only for permissions and invalid money.
4. **Plain words** in the three languages; no accounting jargon ("Owes you", "You owe", "Paid to suppliers").
5. **Numbers are sacred**: right-aligned, tabular figures, always `Rs` prefix, never truncated.

### 1.1 Reference-derived patterns (desktop app only; not its visual identity)

The Dukaan desktop screenshots under `docs/reference/dukaan/app-*` are a behaviour reference. The following structural patterns are adopted with Bikri's own brand and components; the web screenshots are ignored.

- **Page header**: a pastel icon tile, the page title and a one-line subtitle, with the primary action at the end. Secondary actions go behind a `More` (kebab) menu (Products).
- **Home**: a large `New sale` hero card with a short hint, a two-column grid of action cards that each carry an icon, title and short description, and a right-hand column with a compact `Today's register` summary and `Recent bills`. On phones the register moves directly below the hero.
- **Sell**: customer tabs show each cart's total or `Empty`; the active tab is solid; product tiles show the quantity already in the cart and a green/amber/red stock pill; the cart panel and totals are visually separate surfaces.
- **Pay**: payment methods are descriptive cards (icon + method + hint) with a visible selected check; change and remaining are shown as two summary cards.
- **Settings**: rows have an icon, title, hint and chevron, grouped under short section labels.
- **Lists**: a filter card, a summary card and the rows/table in their own card; page-level titles use the icon header.

Do not copy Dukaan colours, icons, illustrations, wording or pixel layout; the reference only informs structure and hierarchy.

## 2. Design tokens (`apps/pos/src/styles/tokens.css`, Tailwind 4 `@theme`)

### Colour (light / dark) — Algovyn brand (decision D-025)

Bikri uses the **Algovyn brand colours** (Bikri is an Algovyn product), not a palette of its own. Sources, checked 27 Oct 2026:

1. **Live site `https://algovyn.com`** — `<meta name="theme-color" content="#006bb3">`; Tailwind config in the page overrides `blue` with the brand scale `50 #f0f9ff · 100 #e0f2fe · 200 #bae6fd · 300 #7dd3fc · 400 #4da6ff · 500 #2389d9 · 600 #006bb3 · 700 #005a96 · 800 #00497a · 900 #00385d`; focus ring `2px solid #006bb3`; neutrals are Tailwind **slate** (`#0f172a #1e293b #334155 #475569 #64748b #94a3b8 #cbd5e1 #e2e8f0 #f1f5f9 #f8fafc`); status colours used on the page: emerald `#059669/#047857`, red `#dc2626`, amber notice `#f59e0b` / `#fef3c7` / `#92400e`; font Inter. The same scale is in the `AlgoVyn/website` repo (`tailwind.config.cjs`) and its `site.webmanifest` (`theme_color #006bb3`).
2. **Algovyn logo** (`company-logo-only.png`, the "A" mark) — sampled median colours: navy **`#182E55`** and teal **`#4BC2BF`**.
3. The site has **no dark theme**; dark values below are **derived** (brand 400/900 + slate), as are the warning/success shades chosen for text contrast. SmartGrind (another Algovyn product) also uses brand blue `#006bb3` and an amber accent, consistent with this.

| Token | Light | Dark | Use | Origin |
|---|---|---|---|---|
| `--color-bg` | `#F8FAFC` | `#0F172A` | App background | slate-50 / slate-900 (site) |
| `--color-surface` | `#FFFFFF` | `#1E293B` | Cards, modals | site / slate-800 (site) |
| `--color-surface-2` | `#F1F5F9` | `#273449` | Inputs, hover | slate-100 (site) / derived |
| `--color-border` | `#E2E8F0` | `#334155` | Dividers (decorative) | slate-200 / slate-700 (site) |
| `--color-border-strong` | `#64748B` | `#64748B` | Input outlines, controls (≥ 3:1) | slate-500 (site) |
| `--color-text` | `#0F172A` | `#F1F5F9` | Body | slate-900 / slate-100 (site) |
| `--color-text-muted` | `#475569` | `#94A3B8` | Secondary | slate-600 / slate-400 (site) |
| `--color-primary` | `#006BB3` (Algovyn blue) | `#4DA6FF` | Primary buttons, links, focus ring | brand 600 / brand 400 (site) |
| `--color-primary-hover` | `#005A96` | `#7DD3FC` | Hover/pressed | brand 700 / brand 300 (site) |
| `--color-primary-ink` | `#FFFFFF` | `#00385D` | Text on primary | white / brand 900 (site) |
| `--color-primary-subtle` | `#E0F2FE` | `#00385D` | Selected rows, active rail item | brand 100 / brand 900 |
| `--color-primary-subtle-ink` | `#00497A` | `#E0F2FE` | Text on primary-subtle | brand 800 / brand 100 |
| `--color-brand-navy` | `#182E55` | `#182E55` | Logo, receipt preview header | logo |
| `--color-rail` | `#182E55` | `#0B1729` | Desktop rail background | logo navy / derived |
| `--color-rail-ink` | `#F1F5F9` | `#F1F5F9` | Active rail label and icon | slate-100 (site) |
| `--color-rail-muted` | `#B8C6DB` | `#9FB0C9` | Inactive rail labels, brand wordmark | derived |
| `--color-rail-active` | `#4BC2BF` | `#4BC2BF` | Active rail indicator | logo teal |
| `--color-accent` | `#4BC2BF` (Algovyn teal) | `#4BC2BF` | Highlights, "Held" badges, charts accent | logo |
| `--color-accent-ink` | `#182E55` | `#0F172A` | Text on accent | logo navy / slate-900 |
| `--color-danger` | `#DC2626` | `#F87171` | Below cost, refunds, destructive | red-600 (site) / red-400 derived |
| `--color-danger-subtle` / ink | `#FEE2E2` / `#991B1B` | `#450A0A` / `#FECACA` | Error banners | derived (Tailwind red) |
| `--color-warning` | `#B45309` | `#FBBF24` | Low stock, over limit, short | derived (amber-700 / amber-400; site's `#f59e0b` fails text contrast on white) |
| `--color-warning-subtle` / ink | `#FEF3C7` / `#92400E` | `#451A03` / `#FDE68A` | Warning banners | site notice colours / derived |
| `--color-success` | `#047857` | `#34D399` | Synced, drawer correct | emerald-700 (site) / emerald-400 derived |
| `--color-success-subtle` / ink | `#D1FAE5` / `#065F46` | `#022C22` / `#A7F3D0` | Success banners | emerald-100 (site) / derived |
| `--color-info` | `#005A96` | `#7DD3FC` | Neutral notices | brand 700 / brand 300 |
| `--color-info-subtle` / ink | `#F0F9FF` / `#00497A` | `#0C2A44` / `#E0F2FE` | Info banners | brand 50 / derived |

`theme-color` meta and manifest `theme_color`: `#006BB3`. The desktop rail is brand navy in both modes (`--color-rail`), with `--color-rail-ink` labels and a 4 px teal active indicator; the active item also gets a white/10 background. The phone bottom bar stays `--color-surface` so it reads as part of the page.

Category tile colours (8, white initials on each): `#006BB3 #182E55 #0F766E #047857 #B45309 #7C3AED #BE185D #475569` (brand blue, logo navy, teal-700 derived from the logo teal — `#4BC2BF` itself is too light for white text — then emerald, amber, violet, pink, slate).

#### Contrast check (WCAG 2.2 AA: 4.5:1 body text, 3:1 large text / UI components)

Computed with the WCAG relative-luminance formula on 27–28 Oct 2026. CI repeats this with `tools/contrast-check.ts` over the token pairs below and fails on any regression.

| Mode | Pair | Ratio | Needed | Result |
|---|---|---|---|---|
| Light | text `#0F172A` on bg `#F8FAFC` | 17.06 | 4.5 | pass |
| Light | text-muted `#475569` on surface-2 `#F1F5F9` | 6.92 | 4.5 | pass |
| Light | text-muted `#475569` on bg `#F8FAFC` | 7.24 | 4.5 | pass |
| Light | white on primary `#006BB3` | 5.59 | 4.5 | pass |
| Light | white on primary-hover `#005A96` | 7.23 | 4.5 | pass |
| Light | primary `#006BB3` (links) on bg `#F8FAFC` | 5.35 | 4.5 | pass |
| Light | primary-subtle-ink `#00497A` on `#E0F2FE` | 8.19 | 4.5 | pass |
| Light | accent-ink `#182E55` on accent `#4BC2BF` | 6.26 | 4.5 | pass |
| Light | white on brand-navy `#182E55` | 13.45 | 4.5 | pass |
| Light | rail-ink `#F1F5F9` on rail `#182E55` | 12.28 | 4.5 | pass |
| Light | rail-muted `#B8C6DB` on rail `#182E55` | 7.78 | 4.5 | pass |
| Light | rail-active `#4BC2BF` on rail `#182E55` | 6.26 | 4.5 | pass |
| Light | danger `#DC2626` on white / white on danger | 4.83 | 4.5 | pass |
| Light | danger-subtle ink `#991B1B` on `#FEE2E2` | 6.80 | 4.5 | pass |
| Light | warning `#B45309` on white | 5.02 | 4.5 | pass |
| Light | warning ink `#92400E` on `#FEF3C7` | 6.37 | 4.5 | pass |
| Light | success `#047857` on white / white on success | 5.48 | 4.5 | pass |
| Light | success ink `#065F46` on `#D1FAE5` | 6.78 | 4.5 | pass |
| Light | info `#005A96` on white | 7.23 | 4.5 | pass |
| Light | info ink `#00497A` on `#F0F9FF` | 8.82 | 4.5 | pass |
| Light | border-strong `#64748B` on surface-2 `#F1F5F9` | 4.34 | 3.0 | pass |
| Light | focus `#006BB3` on white | 5.59 | 3.0 | pass |
| Dark | text `#F1F5F9` on bg `#0F172A` | 16.30 | 4.5 | pass |
| Dark | text `#F1F5F9` on surface `#1E293B` | 13.35 | 4.5 | pass |
| Dark | text-muted `#94A3B8` on surface-2 `#273449` | 4.89 | 4.5 | pass |
| Dark | primary-ink `#00385D` on primary `#4DA6FF` | 4.77 | 4.5 | pass |
| Dark | primary `#4DA6FF` (links) on surface `#1E293B` | 5.72 | 4.5 | pass |
| Dark | accent-ink `#0F172A` on accent `#4BC2BF` | 8.30 | 4.5 | pass |
| Dark | danger `#F87171` on surface `#1E293B` | 5.29 | 4.5 | pass |
| Dark | warning `#FBBF24` on surface | 8.76 | 4.5 | pass |
| Dark | success `#34D399` on surface | 7.61 | 4.5 | pass |
| Dark | info `#7DD3FC` on surface | 8.77 | 4.5 | pass |
| Dark | border-strong `#64748B` on surface | 3.07 | 3.0 | pass |
| Dark | primary-ink `#00385D` on primary-hover `#7DD3FC` | 7.31 | 4.5 | pass |
| Dark | rail-ink `#F1F5F9` on rail `#0B1729` | 16.40 | 4.5 | pass |
| Dark | rail-muted `#9FB0C9` on rail `#0B1729` | 8.15 | 4.5 | pass |
| Dark | rail-active `#4BC2BF` on rail `#0B1729` | 8.36 | 4.5 | pass |
| Dark | primary-subtle-ink `#E0F2FE` on `#00385D` | 10.62 | 4.5 | pass |
| Dark | banner inks on danger/warning/success/info subtle | 11.16 / 12.03 / 11.81 / 12.80 | 4.5 | pass |
| Tiles | white on each of the 8 tile colours | 5.02 – 13.45 | 4.5 | pass |

Not allowed: `--color-accent` teal or `#4DA6FF` as text on white (fail 4.5:1); `#94A3B8` as text in light mode; site amber `#F59E0B` or emerald `#059669` as text on white (2.15 / 3.77:1; teal `#4BC2BF` is 2.15:1 and `#4DA6FF` 2.56:1) — use the warning/success tokens instead. Receipts are always black on white and are unaffected by the theme.

### Spacing, radius, elevation

4 px grid: `--space-1 4px` … `--space-8 32px`, `--space-12 48px`. Radius: inputs/buttons 10 px, cards 14 px, modals 18 px, pills 999 px. Shadows: one soft two-layer level for cards (`0 1px 2px rgb(15 23 42 / .04), 0 1px 3px rgb(15 23 42 / .06)`), a top-bar shadow (`0 1px 2px rgb(15 23 42 / .04)`) and one for modals (`0 12px 32px rgb(15 23 42 / .18)`). Touch targets ≥ 44×44 px; buttons on Sell/Pay ≥ 48 px high.

### Typography

| Role | Font | Size / line height |
|---|---|---|
| UI Latin | **Inter** (variable, self-hosted, subset Latin; also the Algovyn website font) | 15/22 body, 13/18 small |
| Screen title (`text-h1`) | Inter semibold | 24/30 |
| Section title (`text-h2`) | Inter semibold | 18/26 |
| Card / dialog title (`text-title`) | Inter semibold | 20/28 |
| Total (`text-total`) | Inter semibold | 28/34; figures 32/40 |
| Urdu | **Noto Nastaliq Urdu** (self-hosted) | +20% size, line height 1.9 (Nastaliq needs more) |
| Numbers / invoice no / SKU | **JetBrains Mono** or Inter with `font-variant-numeric: tabular-nums` | totals 32/40 bold |

All fonts self-hosted in `apps/pos/public/fonts` (woff2), precached; no Google Fonts CDN. Fonts are OFL licensed.

## 3. Layout and responsiveness

Breakpoints: `sm 640`, `md 768`, `lg 1024`, `xl 1280`, `2xl 1536`. Reference viewports for tests: 390×844 (phone), 768×1024 (tablet), 1280×800 (shop PC), 1920×1080. Sell is two-column from `lg`. Rail vertical from `lg`, bottom bar below. Modals are full-screen sheets below `md`.

## 4. Language, RTL and numbers

- Languages: `en`, `ur`, `roman-ur` (Roman Urdu, LTR; same code for the file `roman-ur.json`, i18next and receipts). i18next with namespaces per screen (`sell`, `pay`, `udhaar`…), keys like `sell.take_payment`. Missing key in CI = fail (`i18next-parser` check that all 3 files have identical key sets).
- Urdu sets `<html lang="ur" dir="rtl">`. Use logical CSS only (`ms-`, `me-`, `ps-`, `start`, `end`); icons with direction (arrows, chevrons) flip via `rtl:` variant.
- **Numbers stay Western digits and LTR** in all languages (`<bdi dir="ltr">` around amounts, invoice numbers, phones). Input fields accept Urdu/Arabic-Indic digits (`۰-۹`, `٠-٩`) and normalise.
- Money format: `Rs 43,000` (no decimals when paisa = 0, else `Rs 3,459.77`); negative `−Rs 500` with a true minus; lakh grouping optional (`shop.number_grouping`).
- Dates: `26 Oct 2026, 4:05 PM` (en/roman-ur), Urdu month names in `ur`; always Asia/Karachi.
- Roman Urdu glossary (use consistently): Udhaar, Khata, Baqaya (balance), Wapsi (refund), Rozana hisaab (day close), Kharcha (expense), Supplier, Bill.

## 5. Interaction patterns

- Focus is always visible (2 px `--color-primary` ring + 2 px offset).
- Amount inputs select all on focus (REQ-B07). Enter submits the primary action of the focused form.
- Destructive actions (void, delete, refund) use danger colour, a confirm dialog that states the consequence in money/stock terms, and a reason where the data model requires one.
- Toasts for success; inline messages for validation; banners for system state (offline, update, storage).
- Loading: skeletons for lists > 150 ms; never block the Sell screen with a spinner.
- Sounds (optional): scan beep 880 Hz 60 ms, error 220 Hz 120 ms, sale done 2-tone.

## 6. Global hotkeys

Shortcuts are listed in Settings → About; navigation items also show their key in the tooltip. They are not printed on action buttons. Disabled while typing in a text field unless noted.

| Key | Action | Scope |
|---|---|---|
| `N` | New sale / new item on list screens | global |
| `F2` / `Ctrl+F` | Focus search | Sell, lists (works in fields) |
| `/` | Global search | global |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Switch cart tab | Sell |
| `F3` | Bill discount | Sell |
| `F4` / `Ctrl+H` | Hold bill | Sell |
| `F6` | Held bills | Sell |
| `F7` | Quick sale | Sell |
| `Enter` / `F8` | Take payment / confirm | Sell / Pay |
| `F9` | Open drawer (`drawer.open`) | global |
| `1`–`4` | Payment method | Pay |
| `Ctrl+Shift+P` | Price check | global |
| `Ctrl+Shift+1`…`Ctrl+Shift+9` | Rail items | global |
| `P` | Print / print again | bill detail, sale complete |
| `R` | Refund (bill) / Receive money (statement) / Return to supplier (supplier) | detail screens |
| `L` | Print barcode label | product detail |
| `Ctrl+S` | Save form | forms (works in fields) |
| `Esc` | Close / back / clear | global (works in fields) |
| `Ctrl+L` | Lock | global (works in fields) |

Browser-reserved keys (`F5`, `Ctrl+W`, `Ctrl+T`, `Ctrl+P`) are never bound.

### 6.1 Hotkeys and the browser

Run Bikri as the **installed app** (Chrome/Edge → Install, standalone window) on counter PCs: a browser tab may consume some shortcuts before the page sees them (e.g. `Ctrl+1…8` switch tabs in a normal Chrome tab). Selling and detail actions keep an F-key or plain-key alternative. Each binding above must be checked in both a normal tab and the installed window (T-063); bindings Chrome never delivers to pages (`Ctrl+N`, `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`) are never used (D-020).

## 7. Performance budgets

Measured on the reference shop PC (Intel i3 7th gen / 8 GB / Chrome stable, Windows 10) and a Redmi-class Android phone, with 1,000 products, 20,000 bills, 500 customers in Dexie. Enforced by Playwright traces in CI (desktop profile with 4× CPU throttle as proxy).

| Metric | Budget |
|---|---|
| Keystroke → search results painted | < 50 ms (REQ-B07) |
| Scan (Enter) → line added | < 80 ms |
| Take payment → Pay modal | < 100 ms |
| Done → sale saved (Dexie transaction committed) | < 150 ms |
| Cold start (cached) → PIN screen | < 1.5 s |
| PIN → Sell usable | < 400 ms |
| JS initial bundle (gz) | < 255 KB; route chunks < 100 KB |
| Memory after 8 h of selling | < 300 MB, no growth > 10% per hour |
| Lists | virtualised above 100 rows; 60 fps scroll |

Techniques required: in-memory product search index (prefix + token, normalised Urdu/English, rebuilt on product change), `useDeferredValue` for result lists, no synchronous Dexie queries in render, Web Worker for reports and imports.

## 8. Accessibility

WCAG 2.2 AA: labels on every input (visible), `aria-live="polite"` for totals and change, roles for dialogs with focus trap and return, all actions reachable by keyboard, colour never the only signal (icons + text for Below cost / Short / Over), reduced motion respected, zoom to 200% without loss. Axe check in Playwright on every screen (0 serious/critical).
