# 04 — Home and app shell

**Route** `/`. Landing page for owners and managers after unlock; cashiers land on `/sell` but can open Home.

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan app-home](../reference/dukaan/app-home.png) | Today's figures + quick action tiles |
| ![Dukaan app-home-b](../reference/dukaan/app-home-b.png) | Same, later in the day |
| ![Dukaan app-home-first-run](../reference/dukaan/app-home-first-run.png) | First-run state with "add products" prompt |
| ![Dukaan web-home](../reference/dukaan/web-home.png) | Web demo home |
| ![Dukaan web-theme-dark](../reference/dukaan/web-theme-dark.png) | Dark theme |

## App shell (all screens after unlock)

- **Rail** (desktop ≥ 1024 px: brand-navy vertical rail at the start edge, 72 px, with the Bikri mark and shop name; tablet/mobile: surface bottom bar with 5 items + "More"): Home, Sell, Products, Sales, Udhaar, Suppliers, Expenses, Reports, Settings. The active desktop item has a white/10 panel and a teal indicator. Items the user can't access are hidden. Each item has a tooltip with its hotkey (Ctrl+Shift+1…Ctrl+Shift+9).
- **Top bar** (56 px): screen title; elevated surface with a soft shadow; global search on a tinted field (`/` focuses, with a `/` key hint on desktop; searches products, customers, bills by invoice no); **sync badge**; printer status dot; staff avatar menu (name, role, `Lock` Ctrl+L, `Switch user`).
- **Sync badge** states ([03 §7](../03-sync.md#7-status-shown-to-the-user)): `Synced` (green check), `Syncing…` (spinner), `n waiting` (amber, offline or pending), `Sync problem` (red; click opens Settings → Sync). Tooltip shows last successful sync time.
- **Offline banner**: thin amber bar "Offline — sales are saved on this device" when `navigator.onLine` is false or 3 consecutive pushes fail.
- **Update prompt**: toast "New version ready — Reload" (never auto-reload during a sale).
- **Read-only banner** (warning colours, not dismissable, every screen including the PIN lock) while `kv.tenant_status.status = 'read_only'`, text `tenant.readOnly.banner`; actions that would save business data are hidden or disabled and show `tenant.readOnly.blocked` ([13 §7.2](../13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)).
- **Support access banner** (info colours, every screen) while `kv.support.until` is in the future: `tenant.support.banner` with time and reason, and `End now` for an owner on an admin device ([13 §7.5](../13-multi-tenancy.md#75-operator-support-access-d-084)).

## Home layout

1. **Greeting row**: "Assalam-o-Alaikum, {name}" + business date + branch; on ≥ 640 px a primary `New sale` button sits at the end. On phones the same actions are the first quick-action tiles.
2. **Today cards** (4, 2-up on phones, 4-up from 1280): Sold today (Rs, bill count), Profit today (only with `cost.view`), Cash in drawer (expected so far for this device, per [07 §8](../07-money-rules.md#8-day-close), only with `dayclose.view_expected`), Udhaar given today / received today. Each card has a coloured icon chip, a large value and (where useful) a small secondary line; cards use the soft elevation.
3. **Quick actions** (compact icon+label tiles, 2/3/5 per row): New sale (N), Price check (Ctrl+Shift+P), Products, Sales, Udhaar, Suppliers, Expenses, Day close, Reports, Settings. Shortcuts are in the tooltip and Settings → About.
4. **Attention list** (max 5 items, each linking to the screen): products at or below `min_stock_milli` ("12 items low on stock"), batches expiring in 30 days (v2), udhaar promises due today, customers over limit, failed print jobs, sync conflicts (owner), day not closed yesterday on this device. Shown in a card with a leading status dot and a chevron.
5. **Recent bills**: last 5 bills of this device (invoice, time, total, method chips), in a card with a `View all` link to Sales; click a row for bill detail. Empty state inside the card.

## States

- First run (0 products): replace Today cards with a card "Add your first products" with buttons `Add product`, `Import spreadsheet`, `Add from suggested list` (electronics starter list: charger, cable, earbuds, power bank, screen protector, back cover — names only, user sets prices).
- Cashier without `cost.view`: profit card hidden (not blurred).
- Offline: figures computed from local data, a small "as of this device" pill next to the date.

## Acceptance criteria

1. Today figures equal the Reports "Today" figures for the same device/branch.
2. Hidden rail items are not reachable by URL either (redirect to `/` with toast "You don't have access").
3. `N` from Home opens Sell with focus in search.
4. Low-stock attention item counts only products with `track_stock = 1`.
5. Layout works at 390×844, 768×1024, 1280×800 and 1920×1080 without horizontal scroll.
