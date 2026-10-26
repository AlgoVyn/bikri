# 00 — Overview

## 1. Vision

Bikri is a fast, calm, offline-first POS that a Pakistani shopkeeper can run on the PC or phone they already own, with no installer and no activation. One deployment at `https://algovyn.com/bikri/` serves **several independent shops** (multi-tenant, [13](13-multi-tenancy.md)), run by a platform operator (Adnan, a software developer) who controls the code and the platform: everything is open source, the data is plain SQLite (Cloudflare D1, every row tagged with its shop) plus a full copy of each shop on that shop's tills, and nightly encrypted exports leave Cloudflare. Each shop sees only its own data.

The first tenant is a **cash-heavy electronics/mobile-accessories shop** with 1–2 counters, roughly 50–200 bills a day, a USB barcode gun, a USB thermal receipt printer (model not chosen yet; Bikri is printer-agnostic, 58 mm or 80 mm, see [06](06-printing.md)) and a cash drawer.

## 2. Goals (v1)

1. Ring up a 5-item cash sale and print the receipt in under 20 seconds with keyboard + scanner only.
2. Never block a sale because of network, Cloudflare, or a stock/credit rule.
3. Keep udhaar (customer credit) and supplier dues exactly right, derived from history.
4. Close the day with a cash figure that accounts for every cash movement.
5. Full English, Urdu (RTL) and Roman Urdu UI; Urdu receipts.
6. Run several shops within the Cloudflare free tier (about 10 reference-size shops, [13 §6](13-multi-tenancy.md#6-free-tier-budget-per-shop)), with a clear upgrade path (shards, Workers Paid).
7. **Strict tenant isolation:** no shop can ever read or change another shop's data ([13 §5](13-multi-tenancy.md#5-tenant-scoping-rules-for-implementers)).

## 3. Scope

**In v1:** multiple shops (tenants) on one deployment with a platform operator console (create/suspend/delete shops, owner pairing codes, per-shop usage, export, restore), setup wizard, device enrolment, staff PINs and roles, catalogue with photos, barcode/HID/camera scanning, sell screen with 3 parallel carts and held bills, quick sale, line and bill discounts, cash/card/bank-wallet/udhaar and split payments, ESC/POS printing with cut and drawer, browser-print fallback, receipt logo, reprint, refunds (whole/partial), void-and-reissue, udhaar khata with limits/promises/chase list/WhatsApp, suppliers with deliveries, supplier ledger and returns to supplier, refunds on udhaar bills split automatically between money back and khata, Code 128 barcode labels printed from the browser, optional tax-inclusive (MRP) pricing when tax is enabled (tax off by default), one product per variant/SKU, stock adjustments with reason codes, weighted-average cost, expenses, cash pay-in/pay-out, day close, reports with CSV/PDF export, sync across tills, backups, English/Urdu/Roman Urdu, light/dark theme, text size.

**In v2:** multiple branches with branch reports and stock transfers, per-product tax rates, serial/IMEI tracking and warranty lookup by IMEI (v1 already prints a warranty-until date per line), pack quantities on purchases, product variants (option matrix such as colour × length), direct label-printer commands (TSPL/ZPL), electronics starter catalogue, customer loyalty notes.

**Later / optional:** FBR POS integration (only for Tier-1 retailers, see [12-fbr-later](12-fbr-later.md)), local LAN print bridge, Android TWA wrapper.

## 4. Non-goals

- No self-service sign-up: shops are created by the platform operator ([13 §7.1](13-multi-tenancy.md#71-onboarding-a-new-shop-d-067)). No in-app billing (open question in [13 §9](13-multi-tenancy.md#9-open-questions-owner-decision-needed)).
- No sharing of data between shops (no shared catalogue, customers or stock across tenants).
- No double-entry accounting, payroll, restaurant/table features, e-commerce, loyalty points, multi-currency.
- No batch/expiry tracking (pharmacy feature, not needed for electronics).
- No native mobile or desktop apps; the PWA is the app.
- No editing of saved bills (void and reissue instead).
- No iOS printing/scanning hardware support (iPhone/iPad can view reports and sell without printing).

## 5. Users and roles

| Role | Who | Can |
|---|---|---|
| Platform operator | Adnan (`adnan@yaqoob.org`), not part of any shop | Creates, suspends and deletes shops, issues owner pairing codes, sees usage, exports/restores a shop, holds the backup key. Uses the console at `/admin` (Cloudflare Access) |
| Owner | The owner of one shop | Everything in **that shop**, including settings, staff, devices (on an admin device), cost prices, reports, deletes |
| Manager | Trusted senior staff | Sell, refunds, discounts up to their limit, stock, suppliers, expenses, day close, reports; no staff/device/shop settings |
| Cashier | Counter staff | Sell, discounts up to their limit, receive udhaar payments, price check, own day close; no refunds/voids by default |

Owner, Manager and Cashier are per shop: a person's role, PIN and permissions exist only inside one tenant. Full matrix: [05-auth-and-roles §6](05-auth-and-roles.md#6-permission-matrix).

## 6. Requirements

Requirements are numbered so specs, tasks and tests can reference them.

### 6.1 Core requirements

| ID | Requirement |
|---|---|
| REQ-C01 | Selling, printing, udhaar, stock adjustments, expenses and day close work with no network. |
| REQ-C02 | All money stored and computed as integer paisa; all rules in [07-money-rules](07-money-rules.md). |
| REQ-C03 | Money and stock records are append-only; corrections are new records. |
| REQ-C04 | Stock on hand and party balances are derived from movements/ledger entries. |
| REQ-C05 | Each till syncs automatically within 60 s of a change when online; the rail shows sync status. |
| REQ-C06 | Every bill records branch, device, cashier, time and payment methods. |
| REQ-C07 | A stock or credit-limit rule never blocks a sale (warn only), unless the owner enables a hard credit limit per customer. |
| REQ-C08 | Every screen is fully usable in English, Urdu (RTL) and Roman Urdu. |
| REQ-C09 | Every visible action with a hotkey shows its key badge. |
| REQ-C10 | Every list and report can be exported (see REQ-B02). |
| REQ-C11 | **Tenant isolation.** Every server read and write is scoped to the caller's tenant; no API, file, export or error reveals another tenant's data or whether it exists. Enforced by composite keys and the mandatory cross-tenant test suite ([10 §8](10-testing.md#8-cross-tenant-isolation-suite-mandatory)). |
| REQ-C12 | **Fair share.** One shop reaching its daily free-tier budget never stops another shop's sync, and never blocks a sale on its own tills (they keep selling offline). |
| REQ-C13 | **Per-shop lifecycle.** The operator can create, suspend, export, restore and delete one shop without affecting the others. |

### 6.2 "Where Bikri beats Dukaan" — explicit requirements

These come from hands-on review of Dukaan POS v1.1.2 (see [reference](reference/dukaan/README.md)). Each is mandatory for v1 unless marked v2.

| ID | Requirement | Spec |
|---|---|---|
| REQ-B01 | **Correct day close.** Expected cash = opening + cash sales + udhaar received in cash + pay-ins + cash refunds received from suppliers − cash refunds − cash expenses − cash paid to suppliers (Pay supplier and "Paid now" on deliveries) − pay-outs. Dukaan omits supplier cash payouts. | [07 §8](07-money-rules.md#8-day-close), [screens/15](screens/15-day-close.md) |
| REQ-B02 | **Report export.** Every report and every list (sales, products, customers, suppliers, expenses, stock history, day closes) exports to CSV; reports also export to PDF. Generated on the device, works offline. | [screens/16](screens/16-reports.md) |
| REQ-B03 | **Receipt logo.** Owner uploads a logo (PNG/JPG/SVG); it is printed as a raster image at the top of thermal receipts and shown on shared images and A4. No vendor branding on receipts. | [06 §6](06-printing.md#6-logo-and-urdu-raster-rendering) |
| REQ-B04 | **WhatsApp that works.** Reminders, statements and receipts open WhatsApp via `https://wa.me/<92number>?text=<urlencoded>` and, where supported, also share the PNG image via the Web Share API. Never opens an unrelated page. | [screens/12](screens/12-udhaar.md) |
| REQ-B05 | **No install, no activation.** The till is a web app at `https://algovyn.com/bikri/`; the first device of a shop is enrolled with an owner pairing code from the operator, later tills with codes the shop owner creates in Bikri itself; there is no vendor account, trial or device cap. | [05 §2](05-auth-and-roles.md#2-device-enrolment) |
| REQ-B06 | **Continuous multi-till sync**, not only manual backups. | [03-sync](03-sync.md) |
| REQ-B07 | **Snappy input.** Amount fields select all on focus; no perceptible lag (keystroke-to-paint < 50 ms on a 4-year-old i3 PC with 1,000 products); number-pad keys work everywhere. | [08 §7](08-ux-guidelines.md#7-performance-budgets) |
| REQ-B08 | **Split payments** across cash, card, bank/wallet and udhaar on one bill. | [screens/06](screens/06-pay.md) |
| REQ-B09 | **Whole-rupee cash refunds.** Refund amounts are computed exactly in paisa, then cash refunds round to the nearest rupee with the rounding recorded. | [07 §6](07-money-rules.md#6-refunds) |
| REQ-B10 | **Product photos** on sell tiles and product detail; camera capture or upload; offline cached. | [screens/08](screens/08-products.md) |
| REQ-B11 | **Weighted-average cost** for profit, with last cost kept and shown. | [07 §7](07-money-rules.md#7-cost-weighted-average) |
| REQ-B12 | **Honest history.** Saved bills cannot be edited; "Edit" means void + reissue linked to the original, with an audit entry. | [screens/10](screens/10-sales-and-bill-detail.md) |
| REQ-B13 | **Open source, own data.** Full JSON/CSV export of the shop and restore; nightly SQL export to R2 and off-Cloudflare. | [09-backups-and-ops](09-backups-and-ops.md) |
| REQ-B14 | **Below-cost warning.** Selling a line below its cost shows "Below cost" to everyone; cost and margin are shown only to roles with `cost.view`. | [screens/05](screens/05-sell.md) |
| REQ-B15 | **Failed print never loses a bill.** The sale is saved before printing; failed prints are retried or reprinted from Sales. | [06 §9](06-printing.md#9-print-job-lifecycle-and-errors) |

## 7. Glossary

| Term | Meaning |
|---|---|
| **Udhaar** (اُدھار) | Credit given to a customer: goods now, payment later. |
| **Khata** (کھاتہ) | The ledger/register of a customer's or supplier's udhaar. "Write in khata" = put the bill on credit. |
| **Wasooli** (وصولی) | Collecting money owed; the chase list. |
| **Lena / Dena** | Money to receive / money to pay. |
| **Hisaab** (حساب) | Accounts, the day's reckoning. |
| **Bill / Invoice / Parchi** | A completed sale document. Bikri uses "bill" in UI. |
| **Day close** | End-of-shift count of the cash drawer against the expected amount. |
| **Short / Over** | Counted cash is less / more than expected. |
| **Pay-in / Pay-out** | Cash added to / taken out of the drawer that is not a sale or expense (e.g. float top-up, owner drawing). |
| **Godown** | Back-store / warehouse. |
| **Quick sale** | A sale line for an item not in the catalogue (name + price typed). |
| **Held bill** | A cart parked to serve another customer, resumed later. |
| **Tenant / Shop** | One business on the deployment, with its own data. Row in `tenants`; every business row carries its `tenant_id`. |
| **Platform operator** | Runs the deployment and the console; not a member of any shop. |
| **Admin device** | A till allowed to manage that shop's devices (`devices.is_admin`). |
| **Owner pairing code** | The enrolment code the operator gives a new shop's owner to connect their first (admin) device; valid 72 h. |
| **Shard** | A D1 database holding tenants' data; v1 has one. |
| **Till / Device** | An enrolled browser that sells (counter PC, phone, tablet). Belongs to exactly one shop. |
| **Branch** | A shop location with its own bill prefix. v1 has one ("Main"). |
| **Paisa** | 1/100 of a rupee. All money is stored in paisa. |
| **bp (basis point)** | 1/100 of a percent. 17% = 1700 bp. |
| **ULID** | Sortable 26-character unique ID generated on the client. |
| **Outbox** | Local queue of operations waiting to be pushed to the server. |
| **Op** | One sync operation (insert/upsert/delete of one row). |
| **Cursor / seq** | Server-side monotonically increasing change number used for pull. |
| **Tier-1 retailer** | FBR category (chain, AC mall, high electricity bill or turnover) that must integrate with FBR. Not the target shop. |
| **ESC/POS** | Epson's command language for thermal receipt printers. |
| **Raster** | A bitmap image sent to the printer (used for logo and Urdu text). |
