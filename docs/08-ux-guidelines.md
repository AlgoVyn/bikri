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
- **Home**: a large `New sale` hero card with a short hint, a two-column grid of action cards (three at ≥ 1280 px) that each carry an icon, title and short description, and a right-hand column with a compact `Today's register` summary and `Recent bills`. On phones the register moves directly below the hero.
- **Sell**: customer tabs show each cart's total or `Empty`; the active tab is solid; product tiles show the quantity already in the cart and a green/amber/red stock pill; the cart panel and totals are visually separate surfaces.
- **Pay**: payment methods are descriptive cards (icon + method + hint) with a visible selected check; change and remaining are shown as two summary cards.
- **Settings**: a master–detail split on ≥ 1280 px — the grouped index (icon, title, hint and chevron) stays in the start column and the selected section fills the end column; below 1280 px the section is a full page with a back arrow.
- **Lists and detail**: Sales, Products, Udhaar and Suppliers keep the list full width until a row is selected; at ≥1280 px the selected bill/product/customer/supplier then opens beside it, so there is never an empty detail pane to auto-fill. Below 1280 px the detail is a full page with a back arrow.
- **Lists**: one list surface — the toolbar, context strip and rows/table sit in one card; page-level titles use the icon header.

Do not copy Dukaan colours, icons, illustrations, wording or pixel layout; the reference only informs structure and hierarchy.

Every PR that adds or changes a screen answers the ten questions in the [design review checklist](design-review-checklist.md); a **no** blocks the PR unless a decision records why.

## 2. Design tokens (`apps/pos/src/styles/tokens.css`, Tailwind 4 `@theme`)

### Colour (light / dark) — Algovyn brand (decision D-025)

Bikri uses the **Algovyn brand colours** (Bikri is an Algovyn product), not a palette of its own. Sources, checked 27 Oct 2026:

1. **Live site `https://algovyn.com`** — `<meta name="theme-color" content="#006bb3">`; Tailwind config in the page overrides `blue` with the brand scale `50 #f0f9ff · 100 #e0f2fe · 200 #bae6fd · 300 #7dd3fc · 400 #4da6ff · 500 #2389d9 · 600 #006bb3 · 700 #005a96 · 800 #00497a · 900 #00385d`; focus ring `2px solid #006bb3`; neutrals are Tailwind **slate** (`#0f172a #1e293b #334155 #475569 #64748b #94a3b8 #cbd5e1 #e2e8f0 #f1f5f9 #f8fafc`); status colours used on the page: emerald `#059669/#047857`, red `#dc2626`, amber notice `#f59e0b` / `#fef3c7` / `#92400e`; font Inter. The same scale is in the `AlgoVyn/website` repo (`tailwind.config.cjs`) and its `site.webmanifest` (`theme_color #006bb3`).
2. **Algovyn logo** (`company-logo-only.png`, the "A" mark) — sampled median colours: navy **`#182E55`** and teal **`#4BC2BF`**.
3. The site has **no dark theme**. Bikri's dark theme is the **Graphite** palette (D-217): a neutral near-black canvas with a desaturated brand-blue primary, brand-turquoise success/accent, and the brand-navy rail (`#182E55`). It replaces the earlier slate + electric-blue derivation. SmartGrind (another Algovyn product) also uses brand blue `#006bb3` and an amber accent, consistent with the light theme.

| Token | Light | Dark | Use | Origin |
|---|---|---|---|---|
| `--color-bg` | `#F1F5F9` | `#0E1014` | App background | slate-100 (site) / Graphite near-black (D-217) |
| `--color-surface` | `#FFFFFF` | `#1C2027` | Cards, modals | site / Graphite surface (D-217) |
| `--color-surface-2` | `#F1F5F9` | `#2E333E` | Inputs, hover, elevated surfaces | slate-100 (site) / Graphite elevated (D-217) |
| `--color-border` | `#E2E8F0` | `#656B7B` | Dividers (decorative; ≥ 3:1 on Graphite surfaces) | slate-200 / Graphite (D-217) |
| `--color-border-strong` | `#64748B` | `#8F95A3` | Input outlines, controls (≥ 3:1) | slate-500 (site) / Graphite (D-217) |
| `--color-text` | `#0F172A` | `#E6E8ED` | Body | slate-900 / Graphite off-white (D-217; avoids pure white) |
| `--color-text-muted` | `#475569` | `#9BA1AC` | Secondary / muted | slate-600 / Graphite muted (D-217) |
| `--color-primary` | `#006BB3` (Algovyn blue) | `#5EA5D4` | Primary buttons, links, focus ring | brand 600 / desaturated brand blue (D-217) |
| `--color-primary-hover` | `#005A96` | `#7EB7DD` | Hover/pressed | brand 700 / same-hue lightening (D-217) |
| `--color-primary-ink` | `#FFFFFF` | `#0B283C` | Text on primary | white / Graphite primary ink (D-217) |
| `--color-primary-subtle` | `#E0F2FE` | `#143044` | Selected rows | brand 100 / Graphite (D-217) |
| `--color-primary-subtle-ink` | `#00497A` | `#D6EAF8` | Text on primary-subtle | brand 800 / Graphite (D-217) |
| `--color-brand-navy` | `#182E55` | `#182E55` | Logo, receipt preview header | logo |
| `--color-brand-mark` | `#182E55` | `#E8EEF6` | The book of the Bikri mark on theme surfaces (D-216) | logo navy / Graphite rail ink (D-217) |
| `--color-rail` | `#182E55` | `#182E55` | Desktop rail background | logo navy in both themes; in dark it sits on the Graphite canvas (D-217) |
| `--color-rail-ink` | `#F1F5F9` | `#E8EEF6` | Rail wordmark and book fill (`tone="reversed"`) | slate-100 / Graphite off-white (D-217) |
| `--color-rail-muted` | `#B8C6DB` | `#A9B8CE` | Inactive rail labels and brand wordmark | derived |
| `--color-rail-active` | `#4BC2BF` | `#4BC2BF` | Active rail indicator | logo teal |
| `--color-accent` | `#4BC2BF` (Algovyn teal) | `#4BC2BF` | Highlights, "Held" badges, charts accent | logo |
| `--color-accent-ink` | `#182E55` | `#0E1014` | Text on accent | logo navy / Graphite canvas (D-217) |
| `--color-danger` | `#B91C1C` | `#E89090` | Below cost, refunds, destructive | red-700 (site scale; red-600 fails 4.5:1 on the slate-100 page) / calmer Graphite red (D-217) |
| `--color-danger-subtle` / ink | `#FEE2E2` / `#991B1B` | `#3A1414` / `#F5C8C8` | Error banners | derived (Tailwind red) / Graphite (D-217) |
| `--color-warning` | `#B45309` | `#D9AE4A` | Low stock, over limit, short | derived (amber-700; site's `#f59e0b` fails text contrast on white) / Graphite amber (D-217) |
| `--color-warning-subtle` / ink | `#FEF3C7` / `#92400E` | `#2A2108` / `#F3E0A8` | Warning banners | site notice colours / Graphite (D-217) |
| `--color-success` | `#047857` | `#4BC2BF` | Synced, drawer correct | emerald-700 (site) / brand turquoise (D-217) |
| `--color-success-subtle` / ink | `#D1FAE5` / `#065F46` | `#0C2E2D` / `#B7EBE9` | Success banners | emerald-100 (site) / turquoise tint (D-217) |
| `--color-info` | `#005A96` | `#7EB7DD` | Neutral notices | brand 700 / Graphite info (D-217) |
| `--color-info-subtle` / ink | `#F0F9FF` / `#00497A` | `#102A3C` / `#D6EAF8` | Info banners | brand 50 / Graphite (D-217) |

`theme-color` meta is `#006BB3` in light and `#0E1014` in dark (the Graphite canvas); the manifest `theme_color` stays `#006BB3` (D-025). The desktop rail is brand navy `#182E55` in both themes: in dark it sits on the Graphite canvas, so the column stays branded without a second navy. It carries the Bikri mark (reversed) and the Bikri wordmark, `--color-rail-ink` labels and a 4 px teal active indicator; the active item uses `--color-rail-active-bg` / `--color-rail-active-ink` (white/10 and `#FFFFFF` in light, the same overlay and `#E8EEF6` in dark). Rail edges and hover use `--color-rail-border` and `--color-rail-hover` rather than hard-coded `white/10` and `white/5`. The phone bottom bar stays `--color-surface` so it reads as part of the page.

#### Bikri mark and wordmark (D-216)

The Bikri mark is an **open ledger** with a **tick cut through both pages** and a **turquoise total line** under the book: a sale recorded, a book that balances. The tick is deliberately smaller than the book (brand set v6) and its point sits on the left page, off the spine, so the ledger reads first. The wordmark is **Bikri** in Inter semibold with −1.2% tracking (`tracking-wordmark`), sentence case. Masters: `apps/pos/scripts/brand/` (icons) and [docs/brand/](brand/bikri-horizontal-fullcolour-light.svg) (lockups for docs and the README).

- **UI:** `components/BikriMark.tsx`, an inline SVG drawn from the small-size master (wider tick, heavier total line) so it stays clear at 24–40 px. No tile behind it. The tick is a real cut-out, so it shows the surface behind it.
  - `tone="auto"` (theme surfaces: lock, enrol, setup card, shop request, operator top bar): book `--color-brand-mark`, navy in light and `#E8EEF6` in dark.
  - `tone="reversed"` (the always-navy rail, operator sidebar and setup brand panel): book `--color-rail-ink`.
  - The total line is always `--color-accent` (`#4BC2BF`).
- **Icons** (`apps/pos/public/`, generated by `node scripts/generate-icons.ts`): navy tile, white book, turquoise total line, tick cut through to navy. `icons/app-icon-{192,512}.png` (rounded, purpose `any`), `icons/maskable-{192,512}.png` (full bleed, book inside the 80% safe circle), `icons/apple-touch-icon.png` (180, full bleed; iOS rounds it), `favicon.svg` and `favicon.ico` (16/32/48) from the small-size master.
- Clear space is half the mark's height; do not recolour, rotate, outline or add a tile behind the inline mark, and do not set the wordmark in all caps.

Category tile colours (8, white initials on each): `#006BB3 #182E55 #0F766E #047857 #B45309 #7C3AED #BE185D #475569` (brand blue, logo navy, teal-700 derived from the logo teal — `#4BC2BF` itself is too light for white text — then emerald, amber, violet, pink, slate).

#### Contrast check (WCAG 2.2 AA: 4.5:1 body text, 3:1 large text / UI components)

Computed with the WCAG relative-luminance formula (light pairs 27–28 Oct 2026; Graphite dark pairs 13 Nov 2026, D-217). CI repeats this with `tools/contrast-check.ts` over the token pairs below and fails on any regression.

| Mode | Pair | Ratio | Needed | Result |
|---|---|---|---|---|
| Light | text `#0F172A` on bg `#F1F5F9` | 16.30 | 4.5 | pass |
| Light | text-muted `#475569` on surface-2 `#F1F5F9` | 6.92 | 4.5 | pass |
| Light | text-muted `#475569` on bg `#F1F5F9` | 6.92 | 4.5 | pass |
| Light | white on primary `#006BB3` | 5.59 | 4.5 | pass |
| Light | white on primary-hover `#005A96` | 7.23 | 4.5 | pass |
| Light | primary `#006BB3` (links) on bg `#F1F5F9` | 5.11 | 4.5 | pass |
| Light | primary-subtle-ink `#00497A` on `#E0F2FE` | 8.19 | 4.5 | pass |
| Light | accent-ink `#182E55` on accent `#4BC2BF` | 6.26 | 4.5 | pass |
| Light | white on brand-navy `#182E55` | 13.45 | 4.5 | pass |
| Light | rail-ink `#F1F5F9` on rail `#182E55` | 12.28 | 4.5 | pass |
| Light | rail-muted `#B8C6DB` on rail `#182E55` | 7.78 | 4.5 | pass |
| Light | rail-active `#4BC2BF` on rail `#182E55` | 6.26 | 4.5 | pass |
| Light | danger `#B91C1C` on white / white on danger | 6.47 | 4.5 | pass |
| Light | danger-subtle ink `#991B1B` on `#FEE2E2` | 6.80 | 4.5 | pass |
| Light | warning `#B45309` on white | 5.02 | 4.5 | pass |
| Light | warning ink `#92400E` on `#FEF3C7` | 6.37 | 4.5 | pass |
| Light | success `#047857` on white / white on success | 5.48 | 4.5 | pass |
| Light | success ink `#065F46` on `#D1FAE5` | 6.78 | 4.5 | pass |
| Light | info `#005A96` on white | 7.23 | 4.5 | pass |
| Light | info ink `#00497A` on `#F0F9FF` | 8.82 | 4.5 | pass |
| Light | border-strong `#64748B` on surface-2 `#F1F5F9` | 4.34 | 3.0 | pass |
| Light | focus `#006BB3` on white | 5.59 | 3.0 | pass |
| Dark | text `#E6E8ED` on bg `#0E1014` | 15.53 | 4.5 | pass |
| Dark | text `#E6E8ED` on surface `#1C2027` | 13.33 | 4.5 | pass |
| Dark | text-muted `#9BA1AC` on surface-2 `#2E333E` | 4.87 | 4.5 | pass |
| Dark | primary-ink `#0B283C` on primary `#5EA5D4` | 5.65 | 4.5 | pass |
| Dark | primary `#5EA5D4` (links) on surface `#1C2027` | 6.08 | 4.5 | pass |
| Dark | accent-ink `#0E1014` on accent `#4BC2BF` | 8.86 | 4.5 | pass |
| Dark | danger `#E89090` on surface `#1C2027` | 6.86 | 4.5 | pass |
| Dark | warning `#D9AE4A` on surface `#1C2027` | 7.86 | 4.5 | pass |
| Dark | success `#4BC2BF` on surface `#1C2027` | 7.60 | 4.5 | pass |
| Dark | info `#7EB7DD` on surface `#1C2027` | 7.55 | 4.5 | pass |
| Dark | border-strong `#8F95A3` on surface `#1C2027` | 5.44 | 3.0 | pass |
| Dark | primary-ink `#0B283C` on primary-hover `#7EB7DD` | 7.02 | 4.5 | pass |
| Dark | rail-ink `#E8EEF6` on rail `#182E55` | 11.53 | 4.5 | pass |
| Dark | rail-muted `#A9B8CE` on rail `#182E55` | 6.69 | 4.5 | pass |
| Dark | rail-active `#4BC2BF` on rail `#182E55` | 6.26 | 4.5 | pass |
| Dark | primary-subtle-ink `#D6EAF8` on `#143044` | 11.06 | 4.5 | pass |
| Dark | banner inks on danger/warning/success/info subtle | 10.84 / 12.16 / 11.13 / 11.97 | 4.5 | pass |
| Tiles | white on each of the 8 tile colours | 5.02 – 13.45 | 4.5 | pass |

Not allowed: `--color-accent` teal or `#4DA6FF` as text on white (fail 4.5:1); `#94A3B8` as text in light mode; site amber `#F59E0B` or emerald `#059669` as text on white (2.15 / 3.77:1; teal `#4BC2BF` is 2.15:1 and `#4DA6FF` 2.56:1) — use the warning/success tokens instead. Receipts are always black on white and are unaffected by the theme.

### Spacing, radius, elevation

4 px grid: `--space-1 4px` … `--space-8 32px`, `--space-12 48px`. Radius: inputs/buttons 10 px, cards 14 px, modals 18 px, pills 999 px. Shadows (light): one soft two-layer level for cards (`0 1px 2px rgb(15 23 42 / .04), 0 1px 3px rgb(15 23 42 / .06)`), a top-bar shadow (`0 1px 2px rgb(15 23 42 / .04)`), a matching upward tab-bar shadow, and one for modals (`0 12px 32px rgb(15 23 42 / .18)`). In Graphite dark, card and bar shadows are none — elevation comes from lighter surfaces and the 3:1 border; modals keep a darker shadow (`0 12px 32px rgb(0 0 0 / 0.5)`). Touch targets ≥ 44×44 px; buttons on Sell/Pay ≥ 48 px high.

### Typography

| Role | Font | Size / line height |
|---|---|---|
| UI Latin | **Inter** (variable, self-hosted, subset Latin; also the Algovyn website font) | 15/22 body, 13/18 small |
| Screen title (`text-h1`) | Inter semibold | 24/30 |
| Section title (`text-h2`) | Inter semibold | 18/26 |
| Card / dialog title (`text-title`) | Inter semibold | 20/28 |
| Total (`text-total`) | Inter semibold | 28/34; figures 32/40 |
| Urdu (all surfaces) | **Noto Naskh Arabic UI** (self-hosted) | +20% size, line height 1.7 for body and 1.6 for headings; a dense row may opt into a tighter `leading-*` utility |
| Numbers / invoice no / SKU | **JetBrains Mono** or Inter with `font-variant-numeric: tabular-nums` | totals 32/40 bold |

All fonts self-hosted in `apps/pos/public/fonts` (woff2), precached; no Google Fonts CDN. Fonts are OFL licensed. Single-line controls (inputs and selects) use line-height 1.5 in Urdu; body text keeps the +20% size and 1.7 leading. Naskh is the only Urdu face — headings, dense UI and receipts included (D-157); Latin names and money inside Urdu fall back to Inter.

### Layout containers and page anatomy

Shop screens use one of the four widths below through `pageClass()`; `MasterDetail` owns the workspace width directly, and setup/enrol/lock use the focused width. A screen never invents its own `max-w-*`. The page header and its actions always span the container, never the start column of a split.

| Width | Class | Used by |
|---|---|---|
| Focused | 896 px | setup, enrol, lock, single-column forms |
| Standard | 1152 px | Home, lists, statements, reports, expenses, day close, forms with line items |
| Wide | 1440 px | Settings master–detail |
| Workspace | 1720 px | list + detail workspaces (`MasterDetail`) |

Widths are explicit pixels because the document root is 15 px, so Tailwind's `max-w-6xl` would resolve to 1080 px, not 1152 px.

Page anatomy, top to bottom: **header** (title, one-line purpose, actions) → **context strip** (date presets, filters — flat, not another card) → **content** (one surface per job) → **sticky action bar** on forms. On phones the header keeps title + search + avatar; everything else moves into the staff/More sheet.

### Action hierarchy

1. **One filled primary per screen** — the next thing the user should do.
2. Secondary actions are quiet outlined buttons; tertiary actions are text/icon buttons.
3. Everything else lives in a `More` menu. Destructive actions are **outlined red**, never filled, and always behind a confirm; a confirm dialog may use a filled danger button for its final step.
4. Empty states, dialogs and error banners each offer exactly one primary action.

Implement the hierarchy with `PageActions` (`apps/pos/src/components/`): `primary` is one filled control, `secondary` holds quiet actions, and `more` holds the rest. For list screens, `ListSurface` renders the toolbar, context strip and rows in one surface.

### Surfaces and elevation

A card is a *grouping of one job*, not decoration. Do not nest a filter card, a summary card and a list card on one screen: use one surface with a toolbar and dividers, or keep the context strip flat on the page background. Cards use `border-border` + `shadow-card`; overlays (modal, sheet, menu) are the only surfaces with `shadow-modal`. Spacing inside a surface is 16 px, between sections 24 px, between label and value 4–8 px.

### Motion

Durations: `140ms` for hover/press and small state changes, `200ms` for overlays. Easing `cubic-bezier(.2, 0, 0, 1)`. Nothing bounces. Radix overlays and toasts use the shared `bikri-*` animations in `tokens.css`; `prefers-reduced-motion` reduces every duration. Every async action shows press state, optimistic row, skeleton or toast within 100 ms.

## 3. Layout and responsiveness

Breakpoints: `sm 640`, `md 768`, `lg 1024`, `xl 1280`, `2xl 1536`. Reference viewports for tests: 390×844 (phone), 768×1024 (tablet), 1280×800 (shop PC), 1920×1080. Sell is two-column from `lg`. Rail vertical from `lg`, bottom bar below. Modals are full-screen sheets below `md`.

## 4. Language, RTL and numbers

- Languages: `en`, `ur`, `roman-ur` (Roman Urdu, LTR; same code for the file `roman-ur.json`, i18next and receipts). i18next with namespaces per screen (`sell`, `pay`, `udhaar`…), keys like `sell.take_payment`. Missing key in CI = fail (`i18next-parser` check that all 3 files have identical key sets).
- Urdu sets `<html lang="ur" dir="rtl">`. Use logical CSS only (`ms-`, `me-`, `ps-`, `start`, `end`); icons with direction (arrows, chevrons) flip via `rtl:` variant.
- **Numbers stay Western digits and LTR** in all languages (`<bdi dir="ltr">` around amounts, invoice numbers, phones). Input fields accept Urdu/Arabic-Indic digits (`۰-۹`, `٠-٩`) and normalise.
- Money format: `Rs 43,000` (no decimals when paisa = 0, else `Rs 3,459.77`); negative `−Rs 500` with a true minus; lakh grouping optional (`shop.number_grouping`).
- Dates: `26 Oct 2026, 4:05 PM` (en/roman-ur), Urdu month names in `ur`; always Asia/Karachi. Date fields use the shared `DateField`: a 44 px bordered control with the formatted business date and a calendar icon; the native platform picker sits underneath so mobile/keyboard input keeps working, but its `dd/mm/yyyy` chrome is never shown.
- Roman Urdu glossary (use consistently): Udhaar, Khata, Baqaya (balance), Wapsi (refund), Rozana hisaab (day close), Kharcha (expense), Supplier, Bill.

## 5. Interaction patterns

- Focus is always visible (2 px `--color-primary` ring + 2 px offset).
- Amount inputs select all on focus (REQ-B07). Enter submits the primary action of the focused form.
- Destructive actions (void, delete, refund) use danger colour, a confirm dialog that states the consequence in money/stock terms, and a reason where the data model requires one.
- Toasts for success; inline messages for validation; banners for system state (offline, update, storage).
- Loading: skeletons for lists > 150 ms; never block the Sell screen with a spinner.
- Sounds (optional): scan beep 880 Hz 60 ms, error 220 Hz 120 ms, sale done 2-tone.

## 6. Global hotkeys

Shortcuts are listed in the `?` shortcut sheet (also linked from the staff menu); navigation items also show their key in the tooltip. They are not printed on action buttons, and About does not repeat the table. Disabled while typing in a text field unless noted.

| Key | Action | Scope |
|---|---|---|
| `Ctrl+K` | Command palette | global (works in fields) |
| `?` | Keyboard shortcut sheet | global |
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
| `Ctrl+Shift+P` | Price | global |
| `Ctrl+Shift+H` | Hide/show amounts (privacy mode) | global (works in fields and dialogs) |
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
| JS initial bundle (gz) | < 290 KB (includes the blocking theme script and the active language catalog); route chunks < 100 KB |
| Memory after 8 h of selling | < 300 MB, no growth > 10% per hour |
| Lists | virtualised above 100 rows; 60 fps scroll |

Techniques required: in-memory product search index (prefix + token, normalised Urdu/English, rebuilt on product change), `useDeferredValue` for result lists, no synchronous Dexie queries in render, Web Worker for reports and imports.

## 8. Accessibility

WCAG 2.2 AA: labels on every input (visible), `aria-live="polite"` for totals and change, roles for dialogs with focus trap and return, all actions reachable by keyboard, colour never the only signal (icons + text for Below cost / Short / Over), reduced motion respected, zoom to 200% without loss. Axe check in Playwright on every screen (0 serious/critical).
