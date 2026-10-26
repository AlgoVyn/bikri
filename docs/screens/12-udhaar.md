# 12 — Udhaar (customer credit / khata)

**Routes** `/udhaar` (customers), `/udhaar/:customerId` (statement), `/udhaar/chase` (chase list), modals: new/edit customer, receive payment, promise. Permissions: `payment.receive`, `party.edit`, `party.delete`. Balance rules: [07 §5](../07-money-rules.md#5-customer-and-supplier-balances).

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-udhaar-customers](../reference/dukaan/web-udhaar-customers.png) | Customer list with "owes you" totals |
| ![Dukaan app-udhaar-new-customer](../reference/dukaan/app-udhaar-new-customer.png) | New customer: name, phone (optional), address, note, credit limit ("warns, never stops a sale") |
| ![Dukaan web-udhaar-statement](../reference/dukaan/web-udhaar-statement.png) | Khata with running balance |
| ![Dukaan app-udhaar-statement](../reference/dukaan/app-udhaar-statement.png) | Desktop statement, Received money / Send reminder |
| ![Dukaan web-udhaar-receive-payment](../reference/dukaan/web-udhaar-receive-payment.png) | Receive payment |
| ![Dukaan app-udhaar-receive-payment](../reference/dukaan/app-udhaar-receive-payment.png) | Desktop receive payment |
| ![Dukaan app-udhaar-chase-list](../reference/dukaan/app-udhaar-chase-list.png) | Chase list grouped by age, with promises |
| ![Dukaan app-udhaar-reminder-bug](../reference/dukaan/app-udhaar-reminder-bug.png) | **Anti-pattern**: "Send reminder" opened an unrelated page. Bikri must open WhatsApp correctly (REQ-B04) |

## Customers list

Header cards: **Total owed to you** Rs 1,24,500 (Σ positive balances), customers owing (count), received this month. Toolbar: search (name/phone), filter `All / Owes / Over limit / In credit / Promise due`, sort (`Balance`, `Oldest unpaid`, `Name`, `Last activity`), `+ New customer` (N), `Chase list`, `Export CSV`.

Rows: name, phone, balance (red "Owes Rs 5,890", green "In credit Rs 200", grey "Settled"), oldest unpaid age ("45 days"), limit bar (if limit), next promise date. Click → statement.

## New / edit customer

| Field | Rules |
|---|---|
| Name | required 1–60 |
| Phone | `PhoneInput`, optional; duplicate phone warning with link to existing customer |
| Address | 0–120 |
| Note | 0–200 |
| Credit limit | `MoneyInput`, optional; hint "Warns at checkout, never stops a sale" |
| Hard limit | switch (owner only): "Block udhaar above the limit unless a manager approves" |
| Opening balance | `MoneyInput` (create only): "Already owes from before Bikri" → `ledger_entries` source `opening` |

Changing the limit writes `audit_log credit_limit_change`. Delete: only when balance = 0 (`party.delete`).

## Statement (khata)

Header: name, phone (tap → `tel:`), balance (large), limit, oldest unpaid, promise. Buttons: `Receive money` (R), `Send reminder` (WhatsApp), `Share statement` (PDF / PNG + wa.me), `Add promise`, `Edit`, `Sell to {name}` (opens Sell with customer).

Table (oldest → newest, with "Jump to latest"): date, description ("Bill INV-A-1042 (3 items)" link / "Payment received · Cash" / "Refund on INV-A-1042" / "Opening balance"), debit (gave), credit (got), **balance after each entry**. Date range filter, `Export CSV`, `Print` (80 mm or A4).

### Reminder message (REQ-B04)

`https://wa.me/<E.164 without +>?text=<encodeURIComponent(message)>`, opened in a new tab/app. Message templates (editable in Settings → Udhaar), defaults:

- English: `Assalam-o-Alaikum {name}, your balance at {shop} is Rs {balance} (as of {date}). Please clear it at your convenience. Thank you!`
- Roman Urdu: `Assalam-o-Alaikum {name}, {shop} par aap ka baqaya Rs {balance} hai ({date}). Meharbani kar ke jald ada kar dein. Shukriya!`
- Urdu: `السلام علیکم {name}، {shop} پر آپ کا بقایا {balance} روپے ہے ({date})۔ مہربانی کر کے جلد ادا کر دیں۔ شکریہ!`

Disabled with tooltip "Add a phone number first" when no phone. On devices with Web Share Level 2 + files, a second option shares the statement PNG.

## Receive payment

Fields: amount (`MoneyInput`, prefilled with balance, selects all), method (Cash / Bank-wallet + provider + ref / Card), date (default now; back-dating up to 7 days needs owner), note. Shows "Balance after: Rs 890". Overpayment allowed with confirm "Customer will be in credit Rs 200". Writes recipe "Customer payment"; prints a payment receipt if enabled; opens drawer for cash.

## Promises and chase list

Promise: date (required, ≥ today), amount (optional = whole balance), note. Status becomes `kept` automatically when payments since the promise ≥ promised amount (or balance ≤ 0); `broken` the day after the date if not kept (computed locally each morning; written as an upsert by the first device that notices, idempotent).

Chase list groups customers with balance > 0 by oldest-unpaid age: **0–7 days**, **8–30**, **31–60**, **60+**, plus a top group **Promise due today / overdue**. Each row: name, balance, age, last payment date, buttons `Remind` (wa.me), `Call`, `Promise`, `Receive`. Group totals shown. Export CSV.

## Acceptance criteria

1. Sale with Rs 3,000 udhaar then a Rs 2,110 cash payment gives statement balance column 3,000 → 890.
2. Reminder opens exactly `https://wa.me/923001234567?text=Assalam-o-Alaikum%20Ali%2C…` (Playwright intercepts the popup URL).
3. Customer without phone: reminder disabled.
4. Promise of Rs 2,000 for tomorrow, payment Rs 2,000 today → promise `kept`.
5. Chase list group totals sum to "Total owed to you".
6. Over-limit sale shows warning on pay screen; with hard limit it requires manager PIN.
7. Customer list and statement export to CSV and statement to PDF offline.
