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

## Whole-bundle returns (v1.1)

A bundle is returned in **whole bundle units only**. The refund dialog keeps its existing mode and row patterns:

- In `Choose items`, one bundle group is **one row**: checkbox, bundle name + neutral `Bundle` pill, "Sold 3 · already refunded 0", a whole-bundle quantity stepper `1…remaining`, the group amount (sum of the component line refunds for the selected `k`), one `Put all N items back in stock` checkbox for the group, and a muted line "Includes: <component name × per-bundle qty>…" plus "Whole bundle only — the items cannot be returned separately."
- The component lines of the bundle are **not** separate checkbox/qty rows. A loose line (not in a bundle) keeps the normal per-line row. A refund may combine whole bundle groups and loose lines.
- Changing `k` refunds `per-bundle qty × k` on every component line. The group amount is the sum of those line amounts; the exact/rounding/udhaar split, method choice and "Reduce khata" behaviour are unchanged from §Layout. The group amount can differ by a few paisa from `bundle_price × k / N`; the stored line finals are authoritative.
- If the component stock is not being put back (faulty items), the whole group's restock checkbox is off; all component lines share it.
- `Whole bill` refunds every line/group as today. The Worker rejects any refund that touches only part of a `bundle_group`, uses a different `k` on one component, or refunds a non-multiple of the per-bundle quantity ([04 §5](../04-api.md#5-server-side-checks-beyond-the-request-envelope)).
- After a whole-bundle refund, the bill detail keeps the group header and shows each component's refunded/on-bill quantity; the group is fully refunded when every component line is fully refunded.
- The refund receipt prints one bundle-name header with the returned quantity and the group refund amount, with the component names/quantities underneath, not component prices or the word `Bundle` ([06 §4.3](../06-printing.md#43-other-documents)).

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
9. A bill with 3 bundles + 1 cable opens the refund in Choose items: one bundle row with a whole-bundle stepper, a group amount, one restock checkbox and the includes line; the component lines are not selectable. Returning 1 bundle writes one refund line per component and refunds exactly the component line finals; all tracked components are restocked.
10. Returning the remaining 2 bundles in a second refund makes every component line fully refunded; the group header shows the refunded state and the bill becomes `refunded`; component refund amounts in total equal the group line finals (no drift).
11. A crafted partial component refund (or an old till that sees the component rows) is rejected by the Worker; the till shows the sync failure and does not change the bill.
12. A bundle refund on an udhaar bill uses the same paid/khata split and cash rounding as a normal refund; the refund receipt shows the group header and components, no component prices, and no double-counted amount. English and Urdu at 1280×800 and 390×844.
