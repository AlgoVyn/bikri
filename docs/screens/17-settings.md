# 17 — Settings

**Route** `/settings` with subpages `/settings/<section>`. Left list of sections (top tabs on mobile); sections the user can't access are hidden. Device-level settings live in Dexie `kv` (not synced); shop-level settings are `shop` / `branches` / `staff` rows (synced).

The index has a settings icon, title and one-line subtitle. Each row has an icon, title, hint and chevron, grouped under Shop / This device / Data and help. On ≥ 1024 px Settings uses the reference app's master–detail split: the index stays in the start column and the selected section fills the end column; with nothing selected the end column shows "Choose a setting". Below 1024 px a section is a full page. Every section page has a Back arrow to Settings, and the current row stays highlighted in the index.

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-settings](../reference/dukaan/web-settings.png) | Settings index |
| ![Dukaan app-settings-main](../reference/dukaan/app-settings-main.png) | Desktop settings index (email redacted) |
| ![Dukaan app-settings-receipt-tax](../reference/dukaan/app-settings-receipt-tax.png) | Receipt and tax |
| ![Dukaan web-settings-receipt-tax](../reference/dukaan/web-settings-receipt-tax.png) | Same in web demo |
| ![Dukaan app-settings-cashiers](../reference/dukaan/app-settings-cashiers.png) | Cashiers list |
| ![Dukaan web-settings-cashiers-dark](../reference/dukaan/web-settings-cashiers-dark.png) | Cashiers (dark theme) |
| ![Dukaan app-settings-add-cashier](../reference/dukaan/app-settings-add-cashier.png) | Add cashier with role |
| ![Dukaan app-settings-branches](../reference/dukaan/app-settings-branches.png) | Branches |
| ![Dukaan app-settings-add-branch](../reference/dukaan/app-settings-add-branch.png) | Add branch |
| ![Dukaan app-settings-printer](../reference/dukaan/app-settings-printer.png) | Printer: USB tab ("USB receipt printers show up as serial ports") |
| ![Dukaan app-printer-usb](../reference/dukaan/app-printer-usb.png) | USB printer picker |
| ![Dukaan app-printer-system](../reference/dukaan/app-printer-system.png) / ![Dukaan app-settings-printer-system](../reference/dukaan/app-settings-printer-system.png) | System printer tab |
| ![Dukaan app-printer-office](../reference/dukaan/app-printer-office.png) / ![Dukaan app-settings-printer-office](../reference/dukaan/app-settings-printer-office.png) | Office/A4 printer tab |
| ![Dukaan web-settings-printer](../reference/dukaan/web-settings-printer.png) | Web demo printer settings |
| ![Dukaan app-settings-backup](../reference/dukaan/app-settings-backup.png) / ![Dukaan web-settings-backup](../reference/dukaan/web-settings-backup.png) | Backup (manual file in Dukaan; Bikri syncs continuously + nightly backups, REQ-B06/B13) |
| ![Dukaan app-settings-app-section](../reference/dukaan/app-settings-app-section.png) | App section (theme, cost on till) |
| ![Dukaan app-settings-language](../reference/dukaan/app-settings-language.png) | Language: System / English / Urdu / Roman Urdu |

Dukaan's account/trial/Shop-ID pages are intentionally not referenced; Bikri has no vendor account (REQ-B05).

## Shop profile (`settings.shop`)

Shop name, business type, phone, address, city, NTN/STRN — same rules as [01 step 1](01-setup-wizard.md#step-1--shop). Logo (REQ-B03) with thermal preview and `Remove`.

## Receipt and tax (`settings.shop`)

Header, footer, tax % (bp; default 0 = tax off), **Prices include tax** switch (only shown when tax % > 0; `shop.tax_mode`, default off = tax added on top; changing it shows "Applies to new bills only"), tax label (default "Sales tax"), round total to (No / Rs 1 / Rs 5 / Rs 10), refund rounding (Nearest rupee / Round down / Exact), show cashier name, show payment details, show "You saved Rs …" line (sum of discounts), print warranty line, receipt language (Same as app / English / Urdu), number grouping (International `124,500` or Lakh `1,24,500`). Live 58 mm and 80 mm preview sized to the receipt text (not stretched across the card), which ends with the small "Powered by AlgoVyn" line that every customer receipt carries (not a shop setting, note "Added by AlgoVyn"; [06 §4.4](../06-printing.md#44-powered-by-algovyn-line-d-085), D-085).

## Cashiers (`settings.staff`)

List: name, role, active, last login, PIN status. Add/edit: name (1–40), role (Owner/Manager/Cashier; at least one active owner must remain), PIN set/reset (owner types new PIN twice, or "Let them choose at next unlock" — forces set on first unlock), PIN length 4–6, max discount % (`max_discount_bp`), permission overrides (checkbox list of the 24 keys from [05 §6](../05-auth-and-roles.md#6-permission-matrix) with "Default for role" reset), branches allowed (v2), active switch (deactivate instead of delete). All changes `audit_log staff_change`.

## Branches (`settings.shop`)

v1 shows one branch "Main" (rename, bill prefix 2–6 uppercase letters, address, phone for receipts). Adding branches is v2 (button visible with "Coming soon" disabled). Bill prefix change affects only new bills.

## Categories, expense categories, units

Shortcuts to [08 categories](08-products.md#categories) and expense category management (add/rename/reorder/hide custom ones; system ones can be renamed but not deleted).

## Udhaar

Reminder templates (3 languages, placeholders `{name} {shop} {balance} {date}` validated), default credit limit for new customers, chase list age buckets (fixed in v1).

<a id="printer"></a>
## Printer (`settings.device`, this device only)

Printer-agnostic ([06 §0](../06-printing.md#0-printer-agnostic-design-decision-d-023)). Top of the section: status card + `Set up printer` button (wizard in [06 §8](../06-printing.md#8-printer-setup-and-test-print-per-device)) + link "Which printer should I buy?" ([06 §0.1](../06-printing.md#01-choosing-a-printer-help-text-also-in-settings--printer--which-printer-should-i-buy)). Tabs **USB**, **Serial**, **System**, **A4** for manual changes.

- USB: `Connect printer` (WebUSB `requestDevice` with `classCode: 7` filter), list of granted devices, `Forget`. Explains Chrome/Edge requirement; on Windows, if the printer uses the vendor driver, suggests Serial or System.
- Serial: `Choose port` (Web Serial), baud rate (9600 / 19200 / 38400 / 115200; default 9600).
- System: uses `window.print()` with the 58 mm or 80 mm receipt CSS ([06 §5.3](../06-printing.md#53-system-printing-fallback-also-for-a4office-printers)); tip to set the printer's margins to none. Always available, also as the fallback when USB/Serial is unavailable.
- A4: for invoices/statements on an office printer.
- Common: paper width (58 / 80 mm; advanced 44/76/112), characters per line (default 32 / 48), raster width in dots (default 384 / 576), auto-print after sale (on), copies 1–3, print logo, print QR (bill ID) (off), open drawer on cash sale (on), drawer pin (2/5), cut type (partial/full/none), `Test print` (prints a sample with all character widths, Urdu raster line and logo), `Open drawer`.
- Status: connected / not connected / last error. "A failed print never loses the bill" note (REQ-B15).
- Recent prints: each **Waiting** job has `Cancel print`, and when any are waiting the heading offers `Cancel waiting (N)`; jobs already printing are not cancelled. A job left in `printing` by a closed tab becomes `INTERRUPTED` on the next start and can be retried.

## Labels (`settings.device`, this device only)

Label size (50×25 mm roll, 38×25 mm roll, 40×30 mm roll, A4 sheet 3×8), show shop name, show price, `Print test label`. Stored in `kv.label`. Full spec: [screens/20](20-barcode-labels.md).

## Scanner and display (`settings.device`)

Scanner: test field showing keystroke timing; "suffix Enter" check; camera scanning on/off for phones. Display: theme (Light / Dark / System), text size (100/115/130%), cart order (newest on top/bottom), auto-close sale complete, sounds on/off, auto-lock minutes.

## Language (inside Scanner & display)

System / English / اردو / Roman Urdu; immediate switch; affects UI and (if receipt language = same) receipts. The index has one **Scanner & display** row; Language is the first control on that page, so there is no duplicate Language row.

## Devices (admin devices, owner only)

Shown only on an admin device (`kv.is_admin`) when unlocked as an `owner` (`devices.manage`); online only. Uses `/api/shop/*` with `X-Bikri-Staff` and the owner session ([04 §3.8](../04-api.md#38-shop-admin-endpoints-admin-device)). Everything here is this shop's only.

**Confirm it's you (owner email sign-in, [05 §3.2](../05-auth-and-roles.md#32-owner-email-sign-in-d-082)).** The first action in this section (and in `Download from server`) opens a dialog: "We sent a 6-digit code to a***@gmail.com" → 6-digit input (Urdu digits normalised), `Confirm`, `Send again` (after 60 s), tries left after a wrong code, "Code expires in 10:00". `EMAIL_UNAVAILABLE` → "Email sign-in isn't working for this shop. Contact Algovyn." The session lasts until Lock, Switch user, reload or 12 hours.

- **Add a till**: device name, branch, "Can manage devices" (admin, off) → code `XXXX-XXXX` + QR of the enrol link, 15:00 countdown; list of unused codes with `Cancel`.
- **Devices list**: name, code (A, B…), branch, admin badge, "Algovyn support" badge with end time for a support device (`Revoke` ends support access), last seen, app version, pending ops, status; `Rename`, `Move branch`, `Make admin` / `Remove admin` (not the last admin device), `Revoke` (confirm: "Unsynced sales on that device will stay on it and can be exported there").
- **Import unsynced ops** (revoked devices only): choose the `bikri-unsynced-*.json` file → preview (op count, date range, sales/payment totals) → `Import` → `POST /api/shop/import-ops` in chunks of 200 → summary ([03 §8](../03-sync.md#8-device-revocation-and-data-loss-window)). A file from another shop is refused ("This file is from a different shop").

## This device

Shop name, device name/code/branch, admin or not. `Leave this shop` (owner PIN; blocked while ops are unsynced unless exported first): deletes this shop's local database `bikri-<tenant_id>`, clears `bikri.active_tenant` and goes to the enrol screen. It does not revoke the device on the server (an owner does that in Devices).

## Sync (everyone sees status; actions need owner)

Last push/pull time, pending ops count, failed ops with error and `Retry` / (owner) `Discard` (writes `audit_log sync_ops_discarded`), rejected unique conflicts with links to fix, **Conflicts** list from `sync_conflicts` (owner on an admin device can `Acknowledge`), "Daily sync limit reached — sales are safe on this device and will sync after <local time of 00:00 UTC>" when the shop is over its budget (`TENANT_QUOTA`), "Waiting: this shop is read-only" next to ops held back while the shop is read-only, `Sync now`, device name/code/branch, storage used and persisted status, `Rebuild local data` (owner; re-pulls everything after pushing; `audit_log cache_rebuilt`).

## Backup and export (`export.data`)

- Server backups: "Your data is backed up every night by Algovyn." (the nightly backup covers all shops and is run by the platform operator; shops don't see or download it, [09 §2](../09-backups-and-ops.md#2-nightly-backup-workflow-githubworkflowsbackupyml)). To restore, contact the operator, who restores **this shop only** ([09 §3.4](../09-backups-and-ops.md#34-restore-one-tenant)).
- `Download full export` (all of **this shop's** tables as JSON + CSV zip, generated from local data, REQ-B13).
- `Download from server` (owner, admin device, email sign-in; once per 24 hours): the same zip built from the server copy, including every till's data ([13 §7.3](../13-multi-tenancy.md#73-per-tenant-export-and-restore)); progress per table, resumable for 2 hours. Works in a read-only shop.
- `Restore from export` (owner; only into an empty shop, and only an export of the same shop or one without a tenant; the operator does restores of a live shop), see [09](../09-backups-and-ops.md).
- Unsynced ops of a removed (revoked) till are imported in **Devices** above, not here ([03 §8](../03-sync.md#8-device-revocation-and-data-loss-window)).

## Activity (owner)

Audit log viewer: filters action, staff, device, date; rows show time, staff, action (localised), summary of before → after; `Export CSV`. Source: `audit_log`.

## About

Version, build hash, licence (link to LICENSE), source link (GitHub), check for update, "Terms and privacy" ([09 §6.1](../09-backups-and-ops.md#61-terms-and-privacy-notes-for-shop-owners)).

## Acceptance criteria

1. Changing tax to 17% updates the receipt preview and the next sale's totals; earlier sales are unchanged.
2. A cashier sees only Printer and Scanner & display (which also holds Language), Sync and About ([05 §6](../05-auth-and-roles.md#6-permission-matrix) `settings.device`).
3. Removing the last active owner is impossible ("At least one owner is needed").
4. Test print at 80 mm prints 48 characters per line exactly (32 at 58 mm), the logo and an Urdu line, over USB and over Serial; with no WebUSB/Web Serial (Firefox) only System printing is offered.
5. The `Set up printer` wizard completes with paper width + transport + test print answers and saves `kv.printer`; a failed USB claim offers Serial/System instead of an error dead end.
6. `Download full export` works offline and contains every table with row counts matching the device.
7. The `#printer` link opens the Printer section directly.
8. With tax 0 the "Prices include tax" switch is hidden and `tax_mode` is `exclusive`; after setting 17% and switching it on, the next Rs 11,700 bill totals Rs 11,700 with "Includes Sales tax 17%: Rs 1,700" (T9), while bills saved earlier are unchanged.
9. On an admin device unlocked as owner, `Add a till` produces a code that enrols a device into this shop only; on a non-admin device or as a manager the Devices section is hidden and `/api/shop/*` returns 403.
10. `Leave this shop` removes every IndexedDB database and cache entry of this shop from the browser.
11. Device actions and `Download from server` need a fresh email code after Lock; a manager or a non-admin device never sees them.
12. In a read-only shop, every section still shows its data; only local device settings (printer, scanner, display, language) can be changed.
