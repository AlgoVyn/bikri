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

- **Rail** (desktop ≥ 1024 px: brand-navy vertical rail at the start edge, 72 px, with the Bikri mark, the BIKRI wordmark and the shop name underneath; tablet/mobile: surface bottom bar with 5 items + "More"): Home, Sell, Products, Sales, Udhaar, Suppliers, Expenses, Reports, Settings. The active desktop item has a white/10 panel and a teal indicator. Items the user can't access are hidden. Each item has a tooltip with its hotkey (Ctrl+Shift+1…Ctrl+Shift+9).
- **Top bar** (56 px): screen title; elevated surface with a soft shadow; global search on a tinted field (`/` focuses, with a `/` key hint on desktop; searches products, customers, bills by invoice no); **sync badge** and **printer pill** on desktop only; staff avatar menu (user icon + name, role, `Lock` with a padlock icon, Ctrl+L). On phones the title keeps the space: sync and printer move into the staff menu, and the language select stays compact.
- **Sync badge** states ([03 §7](../03-sync.md#7-status-shown-to-the-user)): `Synced` (green check), `Syncing…` (spinner), `n waiting` (muted, offline or pending), `Sync problem` (red; click opens Settings → Sync). Tooltip shows last successful sync time. The printer pill is neutral “No printer” (accessible label “Printer not set up”), green “Printer ready” or red “Print failed”, never colour-only.
- **Offline banner**: thin amber bar "Offline — sales are saved on this device" when `navigator.onLine` is false or 3 consecutive pushes fail.
- **Update prompt**: toast "New version ready — Reload" (never auto-reload during a sale).
- **Read-only banner** (warning colours, not dismissable, every screen including the PIN lock) while `kv.tenant_status.status = 'read_only'`, text `tenant.readOnly.banner`; actions that would save business data are hidden or disabled and show `tenant.readOnly.blocked` ([13 §7.2](../13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)).
- **Support access banner** (info colours, every screen) while `kv.support.until` is in the future: `tenant.support.banner` with time and reason, and `End now` for an owner on an admin device ([13 §7.5](../13-multi-tenancy.md#75-operator-support-access-d-084)).

## Home layout

1. **Greeting row**: "Assalam-o-Alaikum, {name}" + business date + branch.
2. **New sale hero** (main column): a large primary-subtle card with a receipt icon, `New sale`, the hint "Tap to ring up items or scan a barcode" and a chevron; opens Sell.
3. **Quick actions** (main column, 1 column on phones / 2 from 640 px): Day close, Products, Sales, Udhaar, Suppliers, Expenses, Reports, Settings, Price check. Each is a card with an icon, title and a short description ("Scan a barcode", "Manage stock", "Bills & refunds", …); shortcuts are in the tooltip and Settings → About.
4. **Today** (right column on ≥ 1024 px; directly below the hero on phones): Sold today (large), bill count and last bill time; Cash in drawer (only with `dayclose.view_expected`), Profit today (only with `cost.view`) and Udhaar given/received, plus a `Day close` action when the user has `dayclose.create`. The register stays a single card rather than four separate tiles.
5. **Attention list** (main column, max 5): products at or below `min_stock_milli` ("12 items low on stock"), batches expiring in 30 days (v2), udhaar promises due today, customers over limit, failed print jobs, sync conflicts (owner), day not closed yesterday on this device. Card with a leading status dot and a chevron.
6. **Recent bills** (right column on ≥ 1024 px; below the register/market on phones): the shop’s last 5 bills, newest first (invoice, time, total, method chips), in a card with a `View all` link to Sales; click a row for bill detail. Empty state inside the card. Bills from every till in the shop appear; the invoice prefix shows the device.

## States

- First run (0 products): replace the hero/register with a card "Add your first products" with buttons `Add product`, `Import spreadsheet`, `Add from suggested list` (electronics starter list: charger, cable, earbuds, power bank, screen protector, back cover — names only, user sets prices), followed by quick actions and the empty Recent bills card.
- Cashier without `cost.view`: profit card hidden (not blurred).
- Offline: figures computed from local data, a small "as of this device" pill next to the date.

## Acceptance criteria

1. Today figures equal the Reports "Today" figures for the same device/branch.
2. Hidden rail items are not reachable by URL either (redirect to `/` with toast "You don't have access").
3. `N` from Home opens Sell with focus in search.
4. Low-stock attention item counts only products with `track_stock = 1`.
5. Layout works at 390×844, 768×1024, 1280×800 and 1920×1080 without horizontal scroll.
