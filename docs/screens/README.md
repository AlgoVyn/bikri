# Screen specs

One file per screen. Each spec has the same sections:

1. **Purpose and route** — URL (relative to the base path `/bikri`: route `/sell` is `https://algovyn.com/bikri/sell`; see [01 §1.1](../01-architecture.md#11-url-layout-and-the-path-convention-used-in-these-docs)), who can open it (permission keys from [05 §6](../05-auth-and-roles.md#6-permission-matrix)).
2. **Reference** — Dukaan POS v1.1.2 screenshots showing comparable behaviour. They are a UX reference only: copy the *behaviour*, never the visuals, wording, icons or code ([reference README](../reference/dukaan/README.md)). The screenshots are **local-only** (gitignored); in a clone without them, the written spec is sufficient. Bikri's look (Algovyn brand tokens) comes from [08-ux-guidelines](../08-ux-guidelines.md).
3. **Layout** — regions, from top/start to bottom/end. Directions are logical (`start` = left in LTR, right in Urdu).
4. **Fields and validation** — every input, type, default, rules, and the exact error message key.
5. **States** — empty, loading, offline, error, permission-denied, etc.
6. **Actions and hotkeys** — every button, what it writes (record recipe in [02 §5](../02-data-model.md#5-record-recipes-which-rows-each-action-writes)), its hotkey.
7. **Acceptance criteria** — testable statements; each becomes a Playwright or unit test.

Copy text in specs is the English source string; the implementer adds `en`, `ur`, `roman-ur` keys under the stated i18n namespace.

| # | Screen | Route | File |
|---|---|---|---|
| 01 | Setup wizard (first run) | `/setup` | [01-setup-wizard.md](01-setup-wizard.md) |
| 02 | Enrol this device | `/enrol` | [02-enrol.md](02-enrol.md) |
| 03 | PIN lock | `/lock` | [03-pin-lock.md](03-pin-lock.md) |
| 04 | Home and app shell (rail, sync badge) | `/` | [04-home.md](04-home.md) |
| 05 | Sell | `/sell` | [05-sell.md](05-sell.md) |
| 06 | Pay (modal) | `/sell` (modal) | [06-pay.md](06-pay.md) |
| 07 | Sale complete | `/sell` (modal) | [07-sale-complete.md](07-sale-complete.md) |
| 08 | Products, product detail, add/edit, import, categories | `/products…` | [08-products.md](08-products.md) |
| 09 | Stock adjust and stock count | `/products/:id/adjust`, `/stock/count` | [09-stock-adjust.md](09-stock-adjust.md) |
| 10 | Sales history and bill detail (void/reissue) | `/sales`, `/sales/:id` | [10-sales-and-bill-detail.md](10-sales-and-bill-detail.md) |
| 11 | Refund | `/sales/:id/refund` (modal) | [11-refund.md](11-refund.md) |
| 12 | Udhaar: customers, statement, receive payment, chase list | `/udhaar…` | [12-udhaar.md](12-udhaar.md) |
| 13 | Suppliers and deliveries (purchases) | `/suppliers…` | [13-suppliers-and-purchases.md](13-suppliers-and-purchases.md) |
| 14 | Expenses and cash in/out | `/expenses` | [14-expenses.md](14-expenses.md) |
| 15 | Day close | `/day-close` | [15-day-close.md](15-day-close.md) |
| 16 | Reports | `/reports` | [16-reports.md](16-reports.md) |
| 17 | Settings (all subpages) | `/settings/*` | [17-settings.md](17-settings.md) |
| 18 | Price check | `/price-check` (modal) | [18-price-check.md](18-price-check.md) |
| 19 | Operator console (platform operator, Cloudflare Access) | `/admin/*` | [19-admin.md](19-admin.md) |
| 20 | Barcode labels (browser print) | `/labels` (modal) | [20-barcode-labels.md](20-barcode-labels.md) |

## CSV headers (REQ-B02, T-049)

Every list exports locally, offline. Amounts are rupees (list exports are compact; report and full-export CSVs always have two decimals), quantities are decimal, and text is quoted when needed. The Reports tab headers are in [16-reports](16-reports.md#csv-columns).

| List | Header |
|---|---|
| Products | `name_en,name_ur,category,brand,barcode,sku,price,cost,avg_cost,stock,unit,min_stock,track_stock,sold_30_days` (`cost,avg_cost` only with `cost.view`) |
| Product stock history | `date,reason,qty,balance_after,by` |
| Sales | `invoice_no,date,time,customer,items,subtotal,discounts,tax,total,cash,card,bank_wallet,udhaar,refunded,status,cashier,device` |
| Customers | `name,phone,balance,oldest_unpaid_days,credit_limit,promise_on,last_activity` |
| Customer statement | `date,description,debit,credit,balance` |
| Chase list | `group,name,phone,balance,age_days,last_payment` |
| Suppliers | `name,phone,balance,last_delivery` |
| Supplier statement | `date,description,got,paid,balance` |
| Expenses | `date,category,payee,note,amount,method,staff,device` |
| Day close | `date,device,cashier,period_start,period_end,opening,cash_sales,udhaar_in,pay_ins,supplier_in,refunds,expenses,supplier_out,pay_outs,expected,counted,difference,card,bank,udhaar_given,bills,refunds_count,note` |
| Reports | per-tab headers in [16-reports](16-reports.md#csv-columns) |
| Activity (T-050) | `time,staff,device,action,entity,summary` |

The full export zip adds `manifest.json`, `json/<table>.json` (paisa, no `tenant_id`) and `csv/<table>.csv` (all columns, amounts in rupees with two decimals, timestamps ISO in Asia/Karachi) for every synced table.

## Shared building blocks (implement once in `apps/pos/src/components`)

| Component | Behaviour |
|---|---|
| `MoneyInput` | Shows `Rs` prefix, accepts digits and one `.` with max 2 decimals, selects all on focus (REQ-B07), stores paisa, Urdu digits accepted and normalised. Negative not allowed unless `allowNegative`. |
| `QtyInput` | Integer for `unit` in pc/pair/set/box/pack/dozen, up to 3 decimals for `m`, `kg`, `g`, `l`, `ml`; stores milli. `+`/`−` buttons; keyboard `+`/`-` when focused. |
| `PhoneInput` | Prop `kind: 'mobile' \| 'any'` (default `mobile`). Mobile: accepts `03xxxxxxxxx`, `3xxxxxxxxx`, `+923xxxxxxxxx`, `923xxxxxxxxx`, spaces/dashes ignored; stores E.164 `+923xxxxxxxxx`; displays `0300 1234567`. `any` also accepts landlines `0` + area code + number (10–11 digits total, e.g. `042 35761234`), stored as E.164 `+9242…`, displayed as typed groups. WhatsApp links are offered only for mobile numbers. Error `errors.phone_invalid`. |
| `SearchBox` | Debounce 0 ms for local search (Dexie + in-memory index), barcode scan = rapid keystrokes ending in Enter (< 30 ms between keys) is treated as an exact barcode lookup. |
| `ConfirmDialog` | Title, body, destructive button in danger colour, Esc cancels, Enter confirms only when focus is on the confirm button. |
| `OverrideDialog` | Manager PIN prompt ([05 §4.1](../05-auth-and-roles.md#41-manager-override)). |
| `KeyBadge` | Small key hint on buttons (REQ-C09); hidden on touch-only devices (`pointer: coarse` and no keyboard event seen). |
| `ExportMenu` | CSV (all lists), PDF (reports, statements), Share (Web Share API), generated locally (REQ-B02). |
| `EmptyState` | Illustration-free: icon, one sentence, one primary action. |
| `Toast` | Bottom-end, 4 s, max 3 stacked; errors stay until dismissed. |
