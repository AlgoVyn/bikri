# 11 — Refund

Modal from bill detail. Permission `refund.create` (or manager override). Money: [07 §6](../07-money-rules.md#6-refunds).

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan app-refund-dialog](../reference/dukaan/app-refund-dialog.png) | Whole bill / Choose items, reason, pro-rated amount (Rs 3,459.77) |
| ![Dukaan app-bill-part-refunded](../reference/dukaan/app-bill-part-refunded.png) | Result: Part refunded, Print refund receipt |

Bikri difference: cash refunds rounded to whole rupees with the rounding recorded (REQ-B09): Rs 3,459.77 → **Rs 3,460**.

## Layout

1. Mode: `Whole bill` | `Choose items` (default Choose items when > 1 line).
2. Lines (choose mode): checkbox, name, sold qty, already refunded, refund qty (`QtyInput`, max = sold − refunded), amount (computed live), `Put back in stock` checkbox (default on; off for faulty items).
3. Reason: chips "Faulty", "Changed mind", "Wrong item", "Exchange", Other + text (required, 1–120).
4. Split (automatic, [07 §6.1](../07-money-rules.md#61-refunds-on-udhaar-bills)), shown only when the bill had an udhaar part: "Value Rs 1,250 → **Rs 1,000 back to the customer** (paid part) + **Rs 250 off Ali's khata**". The split is not editable.
5. Refund method (only when the paid part > 0): radio of methods used on the original sale + `Cash`; default `Cash`. When the paid part is 0 (fully udhaar bill, or everything paid was already refunded) there is no method choice and no money changes hands: "Rs 450 will be taken off Ali's khata".
6. Amount block: "Exact Rs 3,459.77 · Rounding +Rs 0.23 · **Refund Rs 3,460**" (rounding only shown for cash), plus "Khata −Rs 250 → balance Rs 1,900" when there is an udhaar part.
7. Footer: `Refund Rs 3,460` (or `Reduce khata Rs 450` when nothing is paid back; primary, danger tone), `Cancel`.

Exchange: after refunding with reason Exchange, a button `Start new sale for this customer` opens Sell with the customer attached.

## Writes

Recipe "Refund" ([02 §5](../02-data-model.md#5-record-recipes-which-rows-each-action-writes)); prints a refund receipt ("REFUND RECEIPT", original invoice no, lines, paid part with method, khata part and new khata balance, reason) if auto-print is on; opens the drawer only when cash is paid back.

## Acceptance criteria

1. Vector R1: refund earbuds from T2 → exact 345977, cash 346000, rounding +23; card refund would be 345977.
2. Refunding each of 3 units in three refunds totals exactly the line final (R4).
3. Refund qty above remaining is impossible (input max).
4. Fully udhaar bill (vector R7): the refund reduces the customer balance by the exact amount; `refunds.method` is NULL, no `payments` row, no drawer opening, no method choice shown.
5. Part-udhaar bill (vectors R5, R6): first refund gives Rs 1,000 cash and takes Rs 250 off the khata; a later refund of the same bill puts everything on the khata; day close counts only the Rs 1,000 as a cash refund.
6. Vectors R8–R10 produce exactly the udhaar part, cash amount and rounding in [07 §6.1](../07-money-rules.md#61-refunds-on-udhaar-bills).
7. After refunding everything, status becomes Refunded and Refund button disappears.
8. A refund created offline on till A and another on till B for the same line: server accepts both (money already left the drawers); if together they exceed what was sold, a `sync_conflicts` row `over_refund` is created and the owner sees a warning on the bill and in Settings → Sync → Conflicts (see [03 §5](../03-sync.md#5-conflict-rules)).
