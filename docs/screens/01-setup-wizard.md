# 01 — Setup wizard (first run)

**Route** `/setup`. Shown on the first enrolled device when `GET /api/me` returns `shop_setup_completed: false`. Not reachable afterwards (redirect to `/`). No PIN needed (the device was just enrolled by the shop owner with the owner pairing code from the operator, [13 §7.1](../13-multi-tenancy.md#71-onboarding-a-new-shop-d-067)). Each shop (tenant) runs this wizard once, on its first admin device; other shops' setups are unrelated.

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan app-welcome](../reference/dukaan/app-welcome.png) | Welcome with language choice before anything else |
| ![Dukaan app-welcome-roman-urdu](../reference/dukaan/app-welcome-roman-urdu.png) | Whole UI switches immediately to Roman Urdu |
| ![Dukaan app-setup-1-shop-details](../reference/dukaan/app-setup-1-shop-details.png) | Step 1 shop details, business type chips |
| ![Dukaan app-setup-1-validation](../reference/dukaan/app-setup-1-validation.png) | Inline required-field errors |
| ![Dukaan app-setup-1-filled](../reference/dukaan/app-setup-1-filled.png) | Filled step 1 |
| ![Dukaan app-setup-2-owner-pin](../reference/dukaan/app-setup-2-owner-pin.png) | Step 2 owner name + PIN (account email redacted) |
| ![Dukaan app-setup-3-receipt-tax](../reference/dukaan/app-setup-3-receipt-tax.png) | Step 3 receipt header/footer and tax % |
| ![Dukaan app-setup-4-first-product](../reference/dukaan/app-setup-4-first-product.png) | Step 4 optional first product |
| ![Dukaan app-setup-4-first-product-scrolled](../reference/dukaan/app-setup-4-first-product-scrolled.png) | Step 4 lower fields |
| ![Dukaan app-setup-done](../reference/dukaan/app-setup-done.png) | Completion screen |
| ![Dukaan web-setup-2-owner-pin](../reference/dukaan/web-setup-2-owner-pin.png) | Web demo version of the PIN step |

Bikri differences: no vendor account, no trial, no activation (REQ-B05); a logo upload in step 3 (REQ-B03); first product step offers "Import spreadsheet" too.

## Layout

Centered card, max width 560 px, on the app background. Top: Bikri wordmark, step indicator "Step n of 4" with 4 dots, language switcher (English / اردو / Roman Urdu) at top-end on every step. Bottom: `Back` (secondary, hidden on step 1) and `Next` / `Finish` (primary). `Skip` (text button) only on step 4.

Step 0 (welcome): heading "Welcome to Bikri", three large language buttons, `Start`.

## Fields and validation

### Step 1 — Shop
| Field | Type | Rules | Error key |
|---|---|---|---|
| Shop name | text, pre-filled with the tenant's `display_name` from enrolment (`kv.tenant`) | required, 2–60 chars, trimmed | `setup.errors.shop_name` |
| Business type | chips (single) | required; options: Electronics (default), Mobile shop, Grocery, General store, Pharmacy, Clothing, Bakery, Hardware, Other | — |
| Currency | read-only | `PKR (Rs)` | — |
| Phone | `PhoneInput kind="any"` | required; mobile or landline (`0xx xxxxxxx`) | `errors.phone_invalid` |
| Address | textarea 2 rows | required, 5–120 chars | `setup.errors.address` |
| City | text | optional, 0–40 | — |
| NTN / STRN | text | optional; shown under "More" disclosure | — |

### Step 2 — Owner
| Field | Type | Rules |
|---|---|---|
| Your name | text | required, 2–40 |
| PIN | 4 masked digit boxes, numeric keypad on touch | 4 digits; weak-PIN list rejected ([05 §4](../05-auth-and-roles.md#4-staff-pins-and-session)) → "Choose a less obvious PIN" |
| Confirm PIN | same | must match → "PINs don't match" |

Hint text: "You'll use this PIN to unlock the till and to manage devices on this admin device. Don't share it."

### Step 3 — Receipt and tax
| Field | Type | Default | Rules |
|---|---|---|---|
| Logo | image picker (PNG/JPG/SVG, ≤ 2 MB) | none | resized to ≤ 576 px wide, stored to R2 via `file_queue`; preview shows the 1-bit dithered thermal look |
| Receipt header | textarea | shop name + address | ≤ 120 chars, up to 3 lines |
| Receipt footer | textarea | "Shukriya! Phir tashreef laiye." | ≤ 160 chars, up to 3 lines |
| Sales tax % | `MoneyInput`-like percent, 0–25, 2 decimals | 0 (tax off) | stored as bp; hint "Applied after discounts. 0 hides the tax line." |
| Prices include tax | switch, **shown only when Sales tax % > 0** | off | `shop.tax_mode = 'inclusive'` when on (MRP pricing, [07 §3](../07-money-rules.md#3-bill-totals)); hint "On: the price on the product is what the customer pays, tax is inside it." Hidden and reset to off when the rate is set back to 0 |
| Round bill total to | select: No rounding / Rs 1 / Rs 5 / Rs 10 | Rs 1 | `round_total_to` |
| Live preview | 80 mm receipt preview at the side (stacked below on mobile) | | updates on every keystroke |

### Step 4 — First products (optional)
Two cards: **Add one product** (inline form = product form from [08](08-products.md#add--edit-product) with name, category, brand, barcode, SKU + Generate, cost, sale price, opening stock, unit, track stock) and **Import a spreadsheet** (opens the import flow from 08 after finishing). `Skip` finishes without products.

## Actions

`Finish` writes, in one Dexie transaction + outbox: `shop` (with `setup_completed_at`), an **upsert of the existing default branch** (created by the Worker when the operator created the shop, [04 §3.7](../04-api.md#37-operator-endpoints-cloudflare-access); never a second insert), owner `staff` (role owner, PIN hash), seed `expense_categories` (already server-seeded; skip if present), optional product + `stock_movements` `opening` with unit cost. Then forces a sync push and navigates to `/` (home) unlocked as the owner. Done screen: "Your shop is ready" with buttons `Start selling` (→ `/sell`) and `Set up printer` (→ `/settings/printer`).

## States

- Offline at Finish: data saved locally, banner "Will sync when online"; allowed.
- Shop already set up on another device (push returns `SETUP_ALREADY_DONE` for `shop`): discard all wizard ops (shop, owner staff, branch upsert, products), re-pull, and show "This shop was already set up on another till" → PIN lock.
- Second device trying setup while another device already finished: server rejects `shop` insert with `SETUP_ALREADY_DONE` (per-op error code); client shows "This shop is already set up on another device" and reloads into sync → PIN lock.
- Refresh mid-wizard: progress kept in `kv.setup_draft`.

## Hotkeys

`Enter` = Next (when no textarea focused), `Esc` = Back, `Alt+1/2/3` = language.

## Acceptance criteria

1. Language chosen on step 0 applies instantly to all text, including direction (`dir="rtl"` for Urdu).
2. `Next` on step 1 with empty fields shows all three required errors at once and focuses the first.
3. Phone `0300-1234567` is saved as `+923001234567`.
4. PIN `1234` is rejected; mismatched confirm is rejected.
5. Tax 17 is stored as `tax_rate_bp = 1700`; preview shows a "Sales tax 17%" line.
6. Uploading a 3000 px logo stores an image ≤ 576 px wide; preview shows it dithered.
7. Skipping step 4 lands on Home with zero products and the "Add your first product" empty state.
8. After Finish, `/setup` redirects to `/`; a second browser enrolled later into the same shop never sees the wizard.
9. Two shops set up on two browsers each get their own shop row, owner and logo; neither shop's Home, receipts or settings show the other's name, logo or data (E2E journey 21).
