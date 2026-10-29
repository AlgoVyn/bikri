# 13 — Suppliers and deliveries (purchases)

**Routes** `/suppliers`, `/suppliers/:id`, `/suppliers/:id/delivery/new`, `/suppliers/:id/return/new`, modal Pay supplier. Permission `purchase.create` (view list: `party.edit` or `purchase.create`).

## Reference

On ≥ 1280 px the supplier list and the selected ledger share one master–detail screen ("Select a supplier" until one is picked); below 1280 px the ledger is a full page with a back arrow.


| Dukaan | What to learn |
|---|---|
| ![Dukaan app-supplier-new](../reference/dukaan/app-supplier-new.png) | New supplier form |
| ![Dukaan app-supplier-delivery-ledger](../reference/dukaan/app-supplier-delivery-ledger.png) | Supplier ledger with deliveries and balance |
| ![Dukaan app-supplier-pay](../reference/dukaan/app-supplier-pay.png) | Pay supplier (in Dukaan this cash is missing from day close — Bikri fixes it, REQ-B01) |

## Suppliers list

Cards: total you owe suppliers. Rows: name, phone, balance ("You owe Rs 85,000" / "Advance Rs 5,000"), last delivery date. `+ New supplier`, `Export CSV`.

New supplier: name (1–60), phone (optional), address, note, opening balance ("You already owe them", creates `ledger_entries` source opening).

## Supplier detail

Header: name, balance, buttons `Record delivery` (D), `Pay supplier` (P), `Return to supplier` (R), `Edit`. Ledger table like the customer khata: date, description ("Delivery #SUP-INV 552, 6 items" / "Paid · Cash" / "Returned 2 items · Faulty" / "Refund received · Cash"), you got (deliveries), you paid / returned, balance after. Each delivery row has `Return items` (opens the return form linked to that delivery). Export CSV / PDF.

## Record delivery (purchase)

| Field | Rules |
|---|---|
| Supplier invoice no | optional 0–30 |
| Date | default now; up to 30 days back |
| Lines | product search/scan (or `+ New product` inline: name, price, unit), qty (`QtyInput` > 0), unit cost (`MoneyInput`, default last cost), line total (computed); "Also update sale price" optional per line |
| Other charges | optional `MoneyInput` (freight/packing **on the supplier's invoice**, owed to the supplier) → `purchases.other_charges`, allocated to lines by `line_total` with `allocate()` → `charges_alloc`, `landed_unit_cost` ([02](../02-data-model.md#2-d1-schema-migration-0001_initsql)). Freight paid in cash to a transporter is **not** entered here: record it as an expense "Transport" |
| Total | Σ line totals + other charges (read-only) |
| Paid now | `MoneyInput` 0…total, method Cash / Bank-wallet / Card |
| Note | 0–200 |

Save writes: `purchases`, `purchase_lines`, `stock_movements` reason `purchase` with `unit_cost` = `landed_unit_cost`, product upserts `last_cost` (and `price` if chosen), `ledger_entries` supplier `+total` and `−paid_now`, `payments` out `purchase_paid_now` when paid now > 0. Summary toast: "Delivery saved · 6 items · Rs 85,000 · you owe Rs 60,000" with an action `Print labels` (opens [screens/20](20-barcode-labels.md) with each line's received quantity, whole units only). A delivery has at most 60 lines ([03 §3](../03-sync.md#3-outbox)).

## Pay supplier

Amount (prefilled balance), method, reference, note → `payments` (out, `supplier_payment`) + `ledger_entries` (−amount). Cash payouts appear in day close as "Paid to suppliers" ([07 §8](../07-money-rules.md#8-day-close)). Opens drawer for cash.

## Return to supplier

Route `/suppliers/:id/return/new` (from supplier detail, or `Return items` on a delivery row, which pre-links that delivery). Permission `purchase.create`. Money rules: [07 §10](../07-money-rules.md#10-return-to-supplier). Writes recipe "Return to supplier" ([02 §5](../02-data-model.md#5-record-recipes-which-rows-each-action-writes)).

| Field | Rules |
|---|---|
| Linked delivery | optional select of this supplier's deliveries (last 180 days); when set, lines are picked from that delivery |
| Lines | linked: the delivery's lines with received qty, already returned qty, `Return qty` (`QtyInput`, max = received − returned); unlinked: product search/scan + qty. `Credit per unit` (`MoneyInput`, `cost.view` only) defaults to the line's landed cost (linked) or the product's average cost; users without `cost.view` cannot change it. Line total computed. Max 60 lines |
| Reason | chips "Faulty", "Wrong item", "Unsold / slow", "Expired", Other + text (required, 1–120) |
| Total credit | Σ line totals (read-only): "Rs 2,400 will be taken off what you owe" |
| Money back now | shown when the return leaves the supplier owing you (`suggested_refund` > 0): `MoneyInput` 0…total, prefilled with the suggestion, method Cash / Bank-wallet. 0 = keep it as an advance |
| Note | 0–200 |

On hand may go below zero (warning "Only 1 in stock", allowed like a sale). Save: one transaction; toast "Returned 2 items · Rs 2,400 · you owe Rs 57,600". Cash received opens the drawer and appears in this device's day close as "Refunds from suppliers (cash)". Prints a `SUPPLIER RETURN` slip ([06 §4.3](../06-printing.md#43-other-documents)) if auto-print is on. `audit_log supplier_return`.

## Acceptance criteria

1. Delivery of 5 @ Rs 1,200 with stock 20 @ avg Rs 1,100 → on hand 25, avg cost Rs 1,120 after server recompute; last cost Rs 1,200.
2. Paid now Rs 5,500 cash appears in that device's day close under "Paid to suppliers" and reduces expected cash (vector D1).
3. Supplier balance = Σ deliveries − Σ payments − Σ paid now.
4. There is no "Supplier" expense category anywhere (REQ-B01).
5. Freight Rs 300 on lines worth Rs 6,000 and Rs 3,000 adds Rs 200 and Rs 100 to the lines' landed cost.
6. Return vectors S1–S3 ([07 §10](../07-money-rules.md#10-return-to-supplier)): S1 credits Rs 2,400 at the landed cost, avg cost stays Rs 1,120, on hand −2; S2 records Rs 550 cash received, supplier balance 0, and day close vector D3 shows it as "Refunds from suppliers (cash)"; S3 leaves an advance of Rs 36,200.
7. A linked return cannot exceed received − already returned in the UI; a return created offline on two tills that together exceed it is accepted and flagged `over_return` in Settings → Sync → Conflicts.
8. Supplier balance after a return = Σ deliveries − Σ payments − Σ paid now − Σ returns + Σ money received back.
