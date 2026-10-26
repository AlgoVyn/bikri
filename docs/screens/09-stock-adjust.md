# 09 — Stock adjust and stock count

**Routes** `/products/:id/adjust` (modal), `/stock/count`. Permission `stock.adjust`. Writes `stock_movements` only (append-only, REQ-C03).

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan app-stock-history](../reference/dukaan/app-stock-history.png) | Movement history with reasons; adjust dialog has tabs In / Out / Count |

## Adjust dialog

Header: product name, "On hand 12 pc". Tabs:

| Tab | Reasons (`reason_code`) | Qty sign | Cost |
|---|---|---|---|
| **Stock in** | Received from godown (`received_godown`), Bought locally (`received_local`), Customer return without bill (`customer_return`), Other (`received_other`) | + | `MoneyInput` unit cost required for `received_*` (default last cost); updates avg ([07 §7](../07-money-rules.md#7-cost-weighted-average)) |
| **Stock out** | Damaged (`damaged`), Expired (`expired`), Lost/stolen (`lost`), Spoiled (`spoiled`), Wrong item delivered (`wrong_item`) | − | none |
| **Count** | Counted quantity → `count` with qty = counted − on hand | ± | none |
| **Fix entry** | `entry_fix` with mandatory note (correcting a typo in a previous adjust) | ± | none |

Fields: Qty (`QtyInput`, > 0 for in/out), Note (required for Other, Lost, Fix entry; 0–120), live "New on hand: 9 pc". Buttons `Save` (Enter) / `Cancel` (Esc). Purchases from suppliers are **not** recorded here: a hint links to "Record a delivery" ([13](13-suppliers-and-purchases.md)).

## Stock count (`/stock/count`)

For a full or category count: choose scope (all tracked / category / low stock), then a list with Expected (on hand at start of count, frozen), Counted (`QtyInput`, scan increments by 1), Difference. Unsaved progress kept in `kv.stock_count_draft`. `Finish count` writes one `count` movement per product with `counted − current on_hand` ≠ 0, using the on-hand **at Finish** (sales made during the count are therefore not lost; the frozen Expected column is display only) and one `audit_log stock_count` with totals (items counted, value difference with `cost.view`). Products with no counted value are skipped (not set to 0) unless "Set uncounted to 0" is ticked.

## Acceptance criteria

1. Stock out 3 "Damaged" on 12 gives 9 and a `damaged` movement of −3000 milli.
2. Count 10 on 12 writes `count` −2000; count equal to on hand writes nothing.
3. Stock in 5 "Bought locally" @ Rs 1,200 on 20 @ Rs 1,100 makes avg cost Rs 1,120 (vector C1).
4. Movements made while another till sold the same item offline both apply after sync (on hand is the sum of all movements).
5. Cashier cannot open the dialog (button hidden; route redirects).
