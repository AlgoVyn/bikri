# 15 — Day close

**Route** `/day-close`. Permission `dayclose.create`; seeing the expected amount before counting needs `dayclose.view_expected` (otherwise **blind count**). Per **device** (each drawer is closed separately). Formula: [07 §8](../07-money-rules.md#8-day-close) (REQ-B01).

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-day-close](../reference/dukaan/web-day-close.png) | Count cash, expected vs counted |
| ![Dukaan app-day-close](../reference/dukaan/app-day-close.png) | Desktop day close with breakdown |
| ![Dukaan app-day-close-b](../reference/dukaan/app-day-close-b.png) | Another day close state |
| ![Dukaan app-day-close-correct](../reference/dukaan/app-day-close-correct.png) | "Drawer is correct" |
| ![Dukaan app-day-closed](../reference/dukaan/app-day-closed.png) | Closed summary |

**Dukaan bug fixed by Bikri**: Dukaan's expected cash ignores money paid to suppliers from the drawer, so the drawer looks short by exactly that amount. Bikri subtracts `supplier_cash_out` (and adds `supplier_cash_in`, cash a supplier pays back for returned goods).

## Layout

Header: device name, period "From Mon 26 Oct, 9:02 AM to now", cashier. Steps:

1. **Count cash**: denomination grid for PKR notes and coins — 5000, 1000, 500, 100, 75 (commemorative, hidden by default), 50, 20, 10, coins 5, 2, 1 — each a count input with row total; or a single "Total counted" `MoneyInput` (toggle). Counted total shown large.
2. **Check** (after `Next`, or live for users with view_expected):

| Line | Amount |
|---|---:|
| Opening cash | 5,000 |
| + Cash sales | 43,000 |
| + Udhaar received in cash | 500 |
| + Cash put in | 0 |
| + Refunds from suppliers (cash) | 0 |
| − Refunds & cancelled bills (cash) | 3,460 |
| − Cash expenses | 300 |
| − **Paid to suppliers (cash)** | 5,500 |
| − Cash taken out | 0 |
| **= Expected in drawer** | **39,240** |
| Counted | 39,200 |
| **Difference** | **Short Rs 40** (red) / Over (amber) / "Drawer is correct" (green) |

Each line is clickable to see the underlying records.

3. **Note** (required if |difference| ≥ Rs 100), `Close day` button.

Also shown (informational, not part of cash): card total, bank/wallet total by provider, udhaar given, bills count, refunds count.

## Writes

One `day_closes` row with every component (CHECK constraint enforces the formula), denominations JSON, note; `audit_log day_close_difference` when |difference| ≥ Rs 100; forces sync. Prints a Z-report on the receipt printer (all lines above + per-method totals + "Closed by"), and offers PDF/CSV export. Next period starts at this close; next opening cash = this counted cash (owner can record "Took home" as a pay-out before closing).

## States

- Unsynced ops from this device: allowed; banner "3 changes not synced yet — figures are from this device".
- Already closed in the last 10 minutes: confirm "Close again?".
- Day not closed yesterday: Home attention item; the period simply continues (covers both days).

## Acceptance criteria

1. Vector D1 produces exactly the table above and a stored row passing the CHECK.
2. Vector D2 (Dukaan screenshot case) shows "Drawer is correct".
3. Vector D3: Rs 550 cash received back from a supplier (return S2) is added to expected cash; the drawer is correct.
4. A cashier without view_expected sees the expected amount only after entering the count.
5. Change returned to customers is never counted (cash sales use applied amounts).
6. Two devices close independently; each only includes its own records.
7. Z-report prints at 58 mm and 80 mm per [06](../06-printing.md).
