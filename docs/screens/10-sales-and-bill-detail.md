# 10 — Sales history and bill detail

**Routes** `/sales`, `/sales/:id`. Cashiers with `report.view` limited to today see only today's bills of their branch. On ≥ 1280 px the list and the selected bill share one master–detail screen ("Select a bill" until one is picked); below 1280 px the bill is a full page with a back arrow.

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-sales-history](../reference/dukaan/web-sales-history.png) | Bill list with method and status |
| ![Dukaan app-sales-7d](../reference/dukaan/app-sales-7d.png) | Range filter 7 days |
| ![Dukaan app-sales-list](../reference/dukaan/app-sales-list.png) | Desktop list |
| ![Dukaan web-bill-detail](../reference/dukaan/web-bill-detail.png) | Bill detail |
| ![Dukaan app-bill-detail](../reference/dukaan/app-bill-detail.png) | Bill detail with Refund, Print, Edit bill |
| ![Dukaan app-bill-part-refunded](../reference/dukaan/app-bill-part-refunded.png) | "Part refunded" with refunded/on-bill per line |
| ![Dukaan app-bill-refunded](../reference/dukaan/app-bill-refunded.png) | Fully refunded |

Bikri difference: **no "Edit bill"**. Instead `Cancel` and `Cancel & reissue` (REQ-B12); the original stays visible with a CANCELLED stamp and a link to the replacement.

## Sales list

Page header: Sales icon, title and a one-line subtitle, with `Record past sale` (owner, `sale.backdate`, not in a read-only shop) and Export at the end. The date presets and the search/filter toolbar each sit in a card; each day's bills are in a card.

Toolbar: date range (Today, Yesterday, 7 days, 30 days, This month, Custom); dates before the shop's first business day or after today are clamped, and a range over two years shows a non-blocking "may take a moment" note; the selected range is remembered on this device. The full-width list has a column header (Time, Invoice, Customer, Items, Total, Method, Status) and fixed column tracks so values line up across rows. Every header sorts within each business day: the first click uses the column's natural order (Time newest first, Total highest first, names A–Z) and clicking it again reverses it; the arrow shows the direction. The toolbar also has a Sort field and direction button for phones, where the header row is hidden. In the master–detail pane it switches to a compact header (Time, Invoice, Total, Status) with the customer under the invoice; search (invoice no, customer name/phone, product name), filters: method (Cash / Card / Bank-wallet / Udhaar / Split), status (Completed / Part refunded / Refunded / Cancelled), cashier, device. `Export CSV` (REQ-B02).

Summary strip above the list (for the filter): bills, sold (net of refunds), refunds, avg bill.

Rows: time, invoice no (mono font), customer, items count, total, method chips, status pill, print status icon (failed prints show a red printer icon — REQ-B15 — click to reprint). A bill recorded on a later day than its `business_date` shows a small **Late** badge beside the invoice. Grouped by business date with day totals. Paginated at day boundaries (about 50 bills per page; a day is never split), read from Dexie index `business_date`.

## Bill detail

Header: invoice no, status pill, date/time, cashier, device, branch, customer (link to statement), and a green `Quotation QTN-…` bar linking back to the quotation when the bill was converted from a quote ([21](21-quotations.md)). Buttons: `Print` (P) is the one filled primary; `Share` (WhatsApp/PDF) and `PDF` are quiet; `Refund` (R, `refund.create`, hidden when status refunded/void) → [11](11-refund.md), `Cancel` (`sale.void`; managers same business date only) and `Cancel & reissue` sit in the More menu with danger styling. On phones the action row stays compact and no destructive action is a filled button. `Audit` (owner: shows audit rows for this bill) is a quiet link beside the status pill, not a primary button.

Body: lines table (name, qty, unit price, line discount, line total, refunded qty, on-bill qty), totals block identical to the receipt, payments list (method, amount, reference, tendered/change), refunds list (each with the money paid back and method, and the part taken off the khata) (each with time, staff, reason, method, amount, rounding, `Print refund receipt`), cancellation info. A line's current product name opens a read-only product peek (D-296; `Open full product` opens the detail; dotted underline + chevron; the visible text stays the immutable `name_snapshot`); quick-sale lines and deleted products stay plain text. A bundle group's header links to the bundle product. The cart line note (`sale_lines.serial`, e.g. serial/IMEI) shows under the item name. A bill remark (`sales.note`) shows below the lines table. A backdated bill shows a warning notice with its sale date, the attributed cashier and the reason.

**Bundle groups.** Lines with the same `bundle_group` are shown under one header row: bundle name, `Bundle × N`, bundle price (`bundle_price × bundle_qty`), and the group's refunded/on-bill state. The component rows under it keep their real product names and per-line quantities, and the per-line refunded/on-bill quantities stay per component; the header is not a separate refundable line. Component rows may show their allocated unit price/line total (they sum to the bundle price) for the owner's reconciliation; the customer receipt never prints component prices. The `Refund` action opens the whole-bundle refund screen ([11](11-refund.md#whole-bundle-returns-v11)). The bill's Print/Share/PDF use the grouped receipt block ([06 §4.1](../06-printing.md#41-sale-receipt-80-mm-48-columns)). The totals block is unchanged and never adds the header and components twice.

### Record a past sale

Owner-only dialog from the Sales page (`sale.backdate`). Fields: **Sale date** (calendar with Today/Yesterday/7-day/30-day presets and month arrows that go back indefinitely; any past date, only future dates disabled; the time of day is the entry time and is not asked), **Made by** (an active owner/manager/cashier; this person is the sale's `staff_id` in reports), **Why was it missed?** (required, 1–120). A warning says the cash must be with the owner, not in the till.

On start, the owner's current device opens an empty cart with the date/staff/reason. The cart shows a banner "Recording a past sale · <date> · <staff>" with the reason and `Cancel past sale`. Payment writes a normal sale on this device with `business_date` = the chosen date, `created_at` = the entry time, and the attributed cashier; it also writes `audit_log sale_backdated` with the owner as recorder, the attributed staff, date and reason. The original till's day close is never changed; the sale counts in the chosen day's reports and in this device's current drawer period if it closes. Cancel = nothing written.

### Cancel

Dialog: reason (required, chips "Wrong item", "Wrong price", "Customer cancelled", "Duplicate bill", Other + text), confirmation shows exactly what will be reversed ("Return Rs 43,000 cash to customer · Put 2 items back in stock · Remove Rs 3,000 from Ali's khata"). Writes recipe "Void" ([02 §5](../02-data-model.md#5-record-recipes-which-rows-each-action-writes)). Not allowed if the sale has refunds (refund the rest instead).

### Cancel & reissue

Opens the Sell screen in a new cart tab prefilled with the original lines, customer, discounts, labelled "Reissue of INV-A-1042". On payment, the sale stores `replaces_sale_id` and the void is written in the same transaction with `replacement_sale_id`. A bundle group is copied as the same snapshot; if the bundle recipe or price changed since the original, the Worker validates the reissued sale against the replaced sale's snapshot (`replaces_sale_id`) rather than the current recipe. Cancel = nothing written.

## Acceptance criteria

1. A bill refunded for 1 of 2 lines shows "Part refunded" and per-line refunded/on-bill qty.
2. Cancelling a cash bill adds a cash `payments` out row (purpose void) that appears in day close "Refunds & cancelled bills".
3. Reissue creates a new invoice number; the original shows VOID + link; reports count only the new one.
4. Export CSV of 7 days has one row per bill with columns `invoice_no,date,time,customer,items,subtotal,discounts,tax,total,cash,card,bank_wallet,udhaar,refunded,status,cashier,device`; the `status` values are `completed`, `part_refunded`, `refunded` and `cancelled`.
5. A bill with a failed print shows the red icon until a reprint succeeds.
6. Owner records a missed cash sale for yesterday: it appears under yesterday with a **Late** badge, the cashier filter finds it, the bill detail shows the reason, and the day close of the original till is unchanged.
7. A cashier/manager cannot see `Record past sale`; a future date is refused and an old date is accepted; cancelling the dialog or the cart writes nothing.
8. The receipt of a backdated bill prints the sale date and `RECORDED LATE`, not the entry date.
9. A bill with a bundle shows one group header (name, `Bundle × N`, bundle price) and the component rows underneath; the header is not counted as another item; per-component refunded/on-bill quantities are correct.
10. Refund from that bill opens the whole-bundle dialog; a partial component return is not offered; after a whole-bundle refund, the group header and component lines show the refunded state and the status is `part_refunded` or `refunded` correctly.
11. Cancel & reissue of a bundle bill prefills the bundle group; if the recipe/price changed, the new sale syncs against the replaced sale's snapshot; the receipt of the reissued bill still prints the original bundle name/components.
12. A bill remark and a cart line note show on the bill detail; the line name links to the current product, while a quick-sale line or a deleted product stays plain text. The same product's stock history links back to that bill.
