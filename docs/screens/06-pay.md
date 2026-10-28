# 06 — Pay (modal)

Opened by `Take payment` on Sell. Two steps like Dukaan ("Step 1 of 2: payment", "Step 2: done"), but with **split payments** (REQ-B08). Money rules: [07 §4](../07-money-rules.md#4-payments).

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-pay-cash](../reference/dukaan/web-pay-cash.png) | Cash: Exact + round-up chips, change to give |
| ![Dukaan app-pay-cash](../reference/dukaan/app-pay-cash.png) | Desktop pay, 4 method tabs, "Done — paid Rs …" button |
| ![Dukaan web-pay-credit](../reference/dukaan/web-pay-credit.png) | Udhaar: customer required |
| ![Dukaan app-pay-udhaar](../reference/dukaan/app-pay-udhaar.png) | Udhaar: already owes, balance after this bill vs limit, "Write in khata" |

## Layout

Modal 640 px wide (full screen < 768 px). Header: "Take payment" + `Total to pay Rs 43,000` (large) + close button (×, also Esc).

1. **Method tabs** (keys `1`–`4`): `Cash`, `Bank / wallet`, `Card`, `Udhaar` as large cards with icons. The selected card uses the primary-subtle background and primary border. Selecting a tab sets "pay the remaining amount with this method".
2. **Method panel**
   - Cash: `Received` `MoneyInput` (prefilled with remaining due, all selected), chips `Exact`, and up to 3 round-ups (07 §4). Shows **`Change to give Rs 600`** in large text (or "Rs 400 still due" in amber).
   - Bank / wallet: provider chips JazzCash / Easypaisa / NayaPay / Bank transfer / Other; `Reference` (optional, 0–40, e.g. transaction ID); amount.
   - Card: `Last 4 digits` (optional), `Reference` (optional); amount.
   - Udhaar: customer picker (required; `+ New customer` inline: name, phone) → shows "Already owes Rs 5,000 · After this bill Rs 48,000 · Limit Rs 50,000" with amber warning when over (07 §4.1). Amount.
3. **Split list**: `+ Split payment` adds another method row. Each row: method, amount, remove. A running line: "Paid Rs 40,000 · Remaining Rs 3,000". The last row's amount defaults to the remaining.
4. **Options**: `Print receipt` toggle (default from device setting), `Send on WhatsApp` toggle (only with a customer phone), `Note` (0–120).
5. **Footer**: primary button reflecting the outcome: "Done — paid Rs 43,000" (Enter), or "Write Rs 43,000 in khata" when fully udhaar, or "Done — Rs 40,000 paid, Rs 3,000 in khata" for a mix. Disabled while remaining ≠ 0 (cash may exceed; others may not).

## Validation

| Rule | Message |
|---|---|
| Σ applied ≠ total | button disabled, remaining shown |
| Non-cash amount makes Σ > total | "Card/bank amount can't be more than what's due" |
| Cash received < cash part | "Rs 400 still due" |
| Udhaar without customer | "Choose a customer for udhaar" |
| Hard limit exceeded | button disabled; `Manager override` link |
| Two rows of the same method | merged automatically |

## What Done writes

Recipe "Sale" in [02 §5](../02-data-model.md#5-record-recipes-which-rows-each-action-writes): `sales` (invoice no `INV-A-1042` from the device sequence, totals, `paid_total`, `udhaar_amount`, `cash_tendered`, `change_given`), `sale_lines` with allocations, `payments` (one per method, `amount = applied`), `ledger_entries` for udhaar, `stock_movements`, optional `audit_log`; all in **one Dexie transaction** with outbox ops. Then: open drawer if any cash (`1B 70 00 19 FA` via printer), queue print job if enabled (failure never undoes the sale, REQ-B15), clear the cart tab, show [07-sale-complete](07-sale-complete.md).

## Hotkeys

`1`–`4` method, `Tab` between fields, `Ctrl+Enter` add split, `Enter` Done (when valid), `Esc` back to cart (nothing saved).

## Acceptance criteria

1. Total Rs 43,000, cash received 50,000 → "Change to give Rs 7,000"; saved `cash_tendered 5000000`, `change_given 700000`, payment amount 4300000.
2. Split Rs 30,000 cash + Rs 13,000 JazzCash (ref "TX123") saves two `payments` rows and the receipt prints both lines.
3. Udhaar Rs 43,000 for a customer with limit Rs 40,000 shows the over-limit warning but completes (soft limit).
4. Mixed Rs 40,000 cash + Rs 3,000 udhaar increases the customer balance by Rs 3,000 exactly.
5. Pressing Enter twice quickly creates exactly one sale (button disabled after first submit; idempotent op id).
6. Pulling the printer cable before Done: sale saved, toast "Print failed — Retry", job visible in Sales.
7. Esc closes without writing anything.
