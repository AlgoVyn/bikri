# 16 — Reports

**Route** `/reports`. Permission `report.view` (cashier: today only); profit figures need `cost.view`; export needs `export.data`. Formulas: [07 §9](../07-money-rules.md#9-reports-formulas). Computed on the device from Dexie (works offline, REQ-B02).

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan web-reports](../reference/dukaan/web-reports.png) | Summary cards |
| ![Dukaan app-reports-today](../reference/dukaan/app-reports-today.png) | Today |
| ![Dukaan app-reports-7d](../reference/dukaan/app-reports-7d.png) | 7 days with chart |
| ![Dukaan app-reports-7d-b](../reference/dukaan/app-reports-7d-b.png) | 7 days, lower part (best sellers, payment mix) |
| ![Dukaan app-reports-custom-range](../reference/dukaan/app-reports-custom-range.png) | Custom range picker |

Bikri difference: every report exports to CSV and PDF (Dukaan has no export).

## Layout

Toolbar: range chips Today / Yesterday / 7 days / 30 days / This month / Last month / Custom (date range picker, max 366 days); the range is remembered on this device; branch (v2) and device filters; `Export ▾` (CSV of the current tab, PDF of the summary).

Tabs:
1. **Summary**: cards Sold, Bills, Average bill, Gross profit, Expenses, Net profit, Margin; daily bar chart (sold, profit line); payment mix donut (cash/card/bank-wallet/udhaar); udhaar given vs received; a "Tax collected" card when tax is enabled ([07 §9](../07-money-rules.md#9-reports-formulas)).
2. **Products**: best sellers by qty and revenue, slow movers (no sale in 30 days with stock > 0), profit by product (`cost.view`), by category, by brand.
3. **Stock**: stock value (avg cost), low stock, out of stock, negative stock exceptions, stock movement summary by reason, supplier returns (count, credit, return difference — informational, not in profit).
4. **Udhaar**: total owed, aging buckets (same as chase list), top debtors.
5. **Staff**: bills, sold, discounts given, refunds, voids by cashier.
6. **Day closes**: list of closes with expected, counted, difference; totals of shorts/overs.
7. **Expenses**: by category.

Table headers follow their column alignment: the first name/date column is start-aligned and numeric/metric columns are end-aligned with their values. Charts are simple SVG components (no heavy chart library; < 30 KB gz). Large ranges compute in a Web Worker with a progress indicator.

## CSV columns

`Export CSV` exports the current tab. Amounts are always rupees with two decimals (`43000.00`), quantities are decimal (`2.5`), and text is quoted when needed. Without `cost.view` the cost/profit columns are omitted.

| Tab | Header |
|---|---|
| Summary | `date,bills,sold,gross_profit,expenses,net_profit,udhaar_given,udhaar_received,tax_collected,cash,card,bank_wallet,udhaar` (one row per day, then `TOTAL`) |
| Products | `product,sku,qty_sold,revenue,cost,profit,margin_pct` (without `cost.view`: `product,sku,qty_sold,revenue`) |
| Stock | `product,sku,on_hand,min_stock,avg_cost,stock_value,status` (without `cost.view`: `product,sku,on_hand,min_stock,status`) |
| Udhaar | `bucket,name,phone,balance,age_days,promise_date` |
| Staff | `cashier,bills,sold,discounts,refunds,refunded_amount,voids,voided_amount,net_sold` |
| Day closes | `date,device,cashier,expected,counted,difference,note` |
| Expenses | `category,amount,share_pct` |

The summary PDF (and Share) is built with the other exports in T-049; this screen ships the CSV of every tab.

## PDF

Generated with pdf-lib on the device: A4 portrait, shop logo + name, range, generated at/by, summary table, chart as embedded PNG, page numbers; Urdu text rendered via embedded Noto Nastaliq subset.

## Acceptance criteria

1. "Today" Sold equals the sum of that day's bill totals minus refunds made that day.
2. Profit for T2 sale with costs Rs 38,000 and Rs 2,500 = (3,954,023 − 3,800,000) + (345,977 − 250,000) paisa = Rs 2,500.00.
3. A refund today of a bill from yesterday reduces today's sold, not yesterday's.
4. Cashier sees only Today and no profit cards.
5. 90-day report with 20,000 bills renders in < 2 s on the reference PC.
6. CSV export columns documented per tab are present and amounts are in rupees with 2 decimals (`43000.00`) — CSV never contains paisa integers.
