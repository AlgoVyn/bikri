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

- **Rail** (desktop ≥ 1024 px: brand-navy vertical rail at the start edge, 88 px, with the Bikri mark and the BIKRI wordmark; tablet/mobile: surface bottom bar with 5 items + "More"): Home, Sell, Products, Sales, Udhaar, Suppliers, Expenses, Reports. Settings opens from the staff menu. Desktop items get extra vertical padding so labels and icons are not crowded. Labels stay on one line; the rail scrolls with the wheel/trackpad but its scrollbar is hidden. The active desktop item has a white/10 panel and a teal indicator. Items the user can't access are hidden. Each item has a tooltip with its hotkey (Ctrl+Shift+1…Ctrl+Shift+9).
- **Desktop shell (≥ 1024 px): rail-only.** The 88 px brand rail is the whole chrome. Clicking the **Bikri mark/wordmark** collapses the rail to an icon-only 64 px column and clicking it again expands it (device-local `bikri.rail_compact`); there is no separate compact button. The nav follows, then a bottom group separated by a divider: **Search** (opens the global search overlay; `/` also works) and the **staff/status avatar**. The avatar's status dot is the summary for sync + printer health; its menu shows both states in words, with links to Settings → Sync / Printer, and the **Settings** row itself. There is no Price button: product hits in global search show the selling price. There is no top bar on desktop: page headers start at the page padding, and master–detail details stick 24 px from the top. Search, account and status are available from the rail on every screen, including Sell.
- **Top bar (below 1024 px only):** 56 px surface with the screen title, the search icon (opens the same overlay), and the staff avatar with its status dot. Settings opens from the avatar menu. There is no amount-privacy eye in the bar; the Today card on Home owns that control. Sync and printer detail live in the staff menu. This applies to phones and tablets, **including Sell**; Sell's own search box starts below it.
- **Global search overlay:** one fixed panel opened by the desktop rail Search item, the phone/tablet search icon or `/`; it searches products, customers and bills by invoice no, and product rows show the selling price. `Ctrl+K` remains the command palette.
- **Sync badge** states ([03 §7](../03-sync.md#7-status-shown-to-the-user)): `Synced` (green check), `Syncing…` (spinner), `n waiting` (muted, offline or pending), `Sync problem` (red; click opens Settings → Sync). Tooltip shows last successful sync time. The printer pill is neutral “No printer” (accessible label “Printer not set up”), green “Printer ready” or red “Print failed”, never colour-only.
- **No separate offline banner**: offline is shown by the **avatar status dot** and the staff-menu status row (`Offline` / `n waiting`), so there is no amber “Offline” bar. Read-only and support banners still appear when those states apply.
- **Update prompt**: a short **Update** item at the foot of the desktop rail (refresh icon with a teal dot) and the same button in the phone/tablet top bar; its tooltip says "Update ready". It never auto-reloads during a sale.
- **Read-only banner** (warning colours, not dismissable, every screen including the PIN lock) while `kv.tenant_status.status = 'read_only'`, text `tenant.readOnly.banner`; actions that would save business data are hidden or disabled and show `tenant.readOnly.blocked` ([13 §7.2](../13-multi-tenancy.md#72-shop-status-active-read-only-suspended-d-080)).
- **Support access banner** (info colours, every screen) while `kv.support.until` is in the future: `tenant.support.banner` with time and reason, and `End now` for an owner on an admin device ([13 §7.5](../13-multi-tenancy.md#75-operator-support-access-d-084)).

## Home layout

1. **Greeting row**: "Assalam-o-Alaikum, {name}" + business date + branch.
2. **Setup strip**: a compact **Get started** card with progress, the next incomplete step and its action, shown above the hero once the catalogue exists; the full three-step card is used only while the catalogue is empty.
3. **New sale hero** (main column): a large primary-subtle card with a receipt icon, `New sale`, the hint "Tap to ring up items or scan a barcode" and a chevron; opens Sell.
4. **Quick actions** (main column, 1 column on phones / 2 from 640 px): Day close, Products, Sales, Udhaar, Suppliers, Expenses, Reports. Each is a card with an icon, title and a short description ("Scan a barcode", "Manage stock", "Bills & refunds", …); shortcuts are in the tooltip and the `?` shortcut sheet. Settings is not repeated here; it opens from the staff menu.
5. **Today** (right column on ≥ 1024 px; directly below the hero on phones): Sold today (large) with the bill count as a pill beside it, a privacy eye immediately after the **Today** heading, and the last bill time on the same line at the end edge; Cash in drawer (only with `dayclose.view_expected`), Profit today (only with `cost.view`) and Udhaar given/received with the label on the left and the amount right-aligned, plus a `Day close` action when the user has `dayclose.create`. The register stays a single card rather than four separate tiles.
6. **Attention list** (main column, max 5): products at or below `min_stock_milli` ("12 items low on stock"), batches expiring in 30 days (v2), udhaar promises due today, customers over limit, failed print jobs, sync conflicts (owner), day not closed yesterday on this device. Card with a leading status dot and a chevron.
7. **Recent bills** (right column on ≥ 1024 px; below the register/market on phones): the shop’s last 5 bills, newest first (invoice, time, total, method chips), in a card with a `View all` link to Sales; click a row for bill detail. Empty state inside the card. Bills from every till in the shop appear; the invoice prefix shows the device.

## Privacy mode

The eye in the Home **Today** card header hides only that card's amounts and remembers the choice in `localStorage['bikri.home_today_hidden']`; it is device-local, never synced and works offline. It is separate from the device-wide privacy setting, so the rest of the app stays readable while the register figures are covered.

A device-wide privacy mode remains available from `Ctrl+Shift+H` and Settings → Scanner & display (`kv.ui.prefs.privacyMode`); it has no rail or top-bar eye. It masks every browsing screen and works offline.

- **Masked by the Today eye:** only Sold today, Cash in drawer, Profit today and Udhaar given/received inside the Home Today card. Counts, bill count, last-bill time and the Day close link stay visible.
- **Masked by device-wide privacy:** Home, Reports, Sales history/detail, bill detail, Udhaar, Suppliers, Expenses, Day close, product cost/margin/stock value; every money value becomes a fixed `Rs ••••` / `−Rs ••••` (never proportional to the amount), and margin/delta percentages become `••%`. Charts are replaced by an “Amounts hidden” panel because bar heights and trend lines leak performance. The real value is not rendered, so screenshots and DOM inspection do not reveal it.
- **Never masked** in the selling flow (Sell, Pay, Sale complete), Price check or any printed receipt/label, PDF/CSV/exported or WhatsApp-reminder output: those amounts are needed to serve the customer and are already customer-facing.
- Counts, quantities, stock levels, dates and invoice numbers stay visible. This is shoulder-surfing privacy, not access control: the PIN lock and permissions (`cost.view`, `report.view`) still enforce who may see what.
- The Today eye shows an eye-off state while enabled; toggling off restores the Today amounts.

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
6. The Today eye hides only the Today card amounts and persists across reload; `Ctrl+Shift+H` (or Settings → Scanner & display) masks every amount on Home/Reports/Sales/Udhaar/Suppliers/Expenses/Day close. Sell, Pay, Sale complete and Price check keep their prices, and print/export output is never masked.
7. The desktop rail is 88 px wide (64 px compact), labels never wrap, nav items have comfortable vertical spacing, and the rail remains scrollable with no visible scrollbar. Clicking the Bikri mark toggles compact; Search sits at the bottom above the staff avatar; Settings is reachable only from the staff menu.
