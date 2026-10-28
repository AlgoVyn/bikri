# 10 — Sales history and bill detail

**Routes** `/sales`, `/sales/:id`. Cashiers with `report.view` limited to today see only today's bills of their branch.

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-sales-history](../reference/dukaan/web-sales-history.png) | Bill list with method and status |
| ![Dukaan app-sales-7d](../reference/dukaan/app-sales-7d.png) | Range filter 7 days |
| ![Dukaan app-sales-list](../reference/dukaan/app-sales-list.png) | Desktop list |
| ![Dukaan web-bill-detail](../reference/dukaan/web-bill-detail.png) | Bill detail |
| ![Dukaan app-bill-detail](../reference/dukaan/app-bill-detail.png) | Bill detail with Refund, Print, Edit bill |
| ![Dukaan app-bill-part-refunded](../reference/dukaan/app-bill-part-refunded.png) | "Part refunded" with refunded/kept per line |
| ![Dukaan app-bill-refunded](../reference/dukaan/app-bill-refunded.png) | Fully refunded |

Bikri difference: **no "Edit bill"**. Instead `Void` and `Void & reissue` (REQ-B12); the original stays visible with a VOID stamp and a link to the replacement.

## Sales list

Page header: Sales icon, title and a one-line subtitle, with Export at the end. The date presets and the search/filter toolbar each sit in a card; each day's bills are in a card.

Toolbar: date range (Today, Yesterday, 7 days, 30 days, This month, Custom); the selected range is remembered on this device. The list has a column header (Time, Invoice, Customer, Items, Total, Method, Status) and fixed column tracks so values line up across rows., search (invoice no, customer name/phone, product name), filters: method (Cash / Card / Bank-wallet / Udhaar / Split), status (Paid / Part refunded / Refunded / Void), cashier, device. `Export CSV` (REQ-B02).

Summary strip above the list (for the filter): bills, sold (net of refunds), refunds, avg bill.

Rows: time, invoice no (mono font), customer, items count, total, method chips, status pill, print status icon (failed prints show a red printer icon — REQ-B15 — click to reprint). Grouped by business date with day totals. Infinite scroll, 50 per page from Dexie index `business_date`.

## Bill detail

Header: invoice no, status pill, date/time, cashier, device, branch, customer (link to statement). Buttons: `Print` (P), `Share` (WhatsApp/PDF), `Refund` (R, `refund.create`, hidden when status refunded/void) → [11](11-refund.md), `Void` (`sale.void`; managers same business date only), `Void & reissue`, `Audit` (owner: shows audit rows for this bill).

Body: lines table (name, qty, unit price, line discount, line total, refunded qty, kept qty), totals block identical to the receipt, payments list (method, amount, reference, tendered/change), refunds list (each with the money paid back and method, and the part taken off the khata) (each with time, staff, reason, method, amount, rounding, `Print refund receipt`), void info.

### Void

Dialog: reason (required, chips "Wrong item", "Wrong price", "Customer cancelled", "Duplicate bill", Other + text), confirmation shows exactly what will be reversed ("Return Rs 43,000 cash to customer · Put 2 items back in stock · Remove Rs 3,000 from Ali's khata"). Writes recipe "Void" ([02 §5](../02-data-model.md#5-record-recipes-which-rows-each-action-writes)). Not allowed if the sale has refunds (refund the rest instead).

### Void & reissue

Opens the Sell screen in a new cart tab prefilled with the original lines, customer, discounts, labelled "Reissue of INV-A-1042". On payment, the sale stores `replaces_sale_id` and the void is written in the same transaction with `replacement_sale_id`. Cancel = nothing written.

## Acceptance criteria

1. A bill refunded for 1 of 2 lines shows "Part refunded" and per-line refunded/kept qty.
2. Voiding a cash bill adds a cash `payments` out row (purpose void) that appears in day close "Refunds & cancelled bills".
3. Reissue creates a new invoice number; the original shows VOID + link; reports count only the new one.
4. Export CSV of 7 days has one row per bill with columns `invoice_no,date,time,customer,items,subtotal,discounts,tax,total,cash,card,bank_wallet,udhaar,refunded,status,cashier,device`.
5. A bill with a failed print shows the red icon until a reprint succeeds.
