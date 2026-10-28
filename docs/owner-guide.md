# Owner guide

Bikri is your shop's till, stock, khata (udhaar) and reports in one app. It runs in Chrome/Edge and works offline: a sale is saved on the till even when the internet is down and syncs when it comes back. Each shop's data is separate from every other shop.

## 1. Put Bikri on the first till

1. Open the pairing link Algovyn sent you (or `https://algovyn.com/bikri/enrol` and type the 8-character code).
2. Enter the till's name and connect. A shop code works once; ask Algovyn for a new one if it expired.
3. The setup wizard asks for:
   - shop name, address and phone (they print on receipts);
   - receipt header/footer, tax label and tax rate (0 if you do not charge tax);
   - your name and a **4–6 digit owner PIN** (do not use `1234`, `1111` or your year of birth);
   - optional logo, printer and first products.
4. Finish. The app installs from the browser menu (**Install app**) for a full-screen till.

You can skip products and printer setup and add them later in Settings.

## 2. Signing in and staff

- The till locks after 10 minutes (change it in Settings → Display), with `Ctrl+L`, or from the avatar menu.
- Pick your name, type your PIN. Wrong PINs lock that profile for a few minutes.
- **Settings → Cashiers** (owner only): add a manager or cashier, set their PIN, role, maximum discount and permissions. Deactivate a person who leaves; their history stays.
- A manager can approve an action the current cashier may not do (refund, large discount, void) with their own PIN. The approval is recorded in Activity.
- Keep at least one active owner. The app refuses to deactivate the last one.

## 3. Selling

1. **Sell** (`N` focuses search). Scan a barcode or type a name/SKU, then Enter.
2. Change quantity, price or line discount if your role allows it.
3. `F2` or **Take payment**: choose cash, card, bank/wallet or **Udhaar** (khata). For cash, enter what the customer gave; change is calculated.
4. Choose the customer for an udhaar sale. A credit limit can warn you or block the sale (owner setting per customer).
5. **Done** saves the sale and can print the receipt, share it on WhatsApp or download a PDF.

The three cart tabs keep separate sales; **Hold** parks a bill and **Resume** brings it back. A held bill expires after 7 days.

## 4. Refunds, voids and exchanges

- **Sales → open a bill → Refund** (`R` on the bill): choose the quantity returned per line, whether it goes back into stock, and how the money is returned. A part-udhaar bill returns cash first, then reduces the khata.
- **Void** cancels a bill that has no refunds. A manager may void only today's bill; older bills need another manager/owner approval. **Void & reissue** opens a new cart with the same lines.
- Refunds and voids are append-only: the original bill and every correction stay in the history and in reports.

## 5. Udhaar (khata)

- **Udhaar** lists every customer, total owed, age and promise date. Search by name or phone.
- Open a customer to see the statement: every sale, payment, refund and adjustment with a running balance.
- **Receive money** records a payment (cash/card/bank); it can be back-dated by an owner.
- **Add promise** records a promised date and amount. The app marks it kept when payments cover it or broken after the date, and the **Chase list** groups who to call.
- Send a reminder on WhatsApp from the customer's page. A customer with no phone has the button disabled.
- CSVs and the statement PDF/PNG can be exported from the customer page.

## 6. Products, stock and suppliers

- **Products**: add name (English and Urdu), price, cost, SKU, barcode, unit, low-stock alert and whether stock is tracked. `Print label` creates a Code 128 barcode label.
- **Stock adjust**: stock in/out, count or correction. A count is saved as a difference, never as an edit of history. Low-stock and slow-moving lists are under Products/Reports.
- **Suppliers**: record deliveries (purchase invoice, lines, freight, paid now) and pay the supplier. A delivery raises stock at the landed cost.
- **Return to supplier**: open a supplier → **Return to supplier**, link the original delivery lines, choose the credit and whether the supplier refunded you now.

## 7. Expenses and day close

- **Expenses**: record cash/card/bank expenses. A cashier can record a small cash expense; larger or non-cash expenses need a manager. A wrong expense is reversed, not deleted.
- **Cash in/out** records money put into or taken out of the drawer.
- **Day close** counts the drawer (notes or a total), shows expected cash, difference and a note. Close once per device at the end of the day; the Z-report can be printed or saved. The next day starts from the counted cash.

## 8. Reports and exports

- **Reports**: today/7 days/30 days/month/custom range, device filter, summary, products, stock, udhaar, staff, day closes and expenses. Profit and cost appear only for owners/managers (or staff with cost permission).
- Every list has a CSV export. Reports also have a summary PDF and a shareable PNG.
- **Settings → Backup** (owner only) downloads a full copy of the shop as a zip (JSON + CSV). **Download from server** needs an admin device and the owner email sign-in; it includes every till, even a lost one.

## 9. Printer and labels

- **Settings → Printer** (owner/manager): choose 58 mm or 80 mm, connect a USB or Serial printer, print a test page and set auto-print/copies/drawer options.
- If the printer is not connected, the receipt stays queued; **Retry** from Sale complete or Settings → Printer.
- **Labels**: from a product (`L`), the product list's Select mode, or after saving a delivery. Choose 50×25, 38×25, 40×30 mm or A4, generate a barcode if needed, and print through the browser dialog. Settings → Labels prints a test label.

## 10. Offline, sync and multiple tills

- A till keeps a full local copy and works with no network. The top bar shows waiting changes, and a banner appears when offline.
- Changes sync automatically. A conflict (the same product/price edited on two tills) is shown in Settings → Sync and resolved by the owner.
- Each till has its own invoice counter and day close. Add tills from **Settings → Devices** (owner on an admin device) and give each its own name.
- One browser profile holds one shop. To run two shops on one PC, use two browser profiles.

## 11. Email sign-in and admin devices

Some actions need the owner email as well as the PIN: server export, device management and owner settings. Enter the 6-digit code sent to your email. The session lasts 12 hours and ends when you lock or switch user. Mark at least one device as **admin** in Settings → Devices.

## 12. Read-only, support access and your data

- If the shop is made **read-only** (for example an unpaid bill), you can still sign in, see reports and history and export your data, but cannot make sales or changes. A banner stays on every screen. Sales made before the till learned the status are kept.
- **Algovyn support** access is explicit, time-limited (1–24 hours) and shown in a banner on every till; the support device is view-only. You can end it with **End now**.
- Every export, import, restore, status change and support session appears in **Settings → Activity** with the reason.
- Algovyn runs the database and holds the backup key, so it can technically read your shop's data; it does so only to run the service, restore it, or when you ask for help. Nightly backups are encrypted; copies expire after 30 days (daily), 12 months (monthly) and 90 days (off-site).
- **Full copy:** Settings → Backup → Export. Do this before leaving Bikri or before a deletion request.
- **Delete a shop:** ask Algovyn; an export is offered first. Its live rows and files are removed, the tenant row stays as a tombstone, and encrypted backup copies expire on the schedule above.

## 13. Quick fixes

| Problem | Try |
|---|---|
| Wrong PIN / locked profile | Wait for the lock, or ask another owner to reset it in Settings → Cashiers. |
| Receipt did not print | Settings → Printer → Recent jobs → Retry; check paper, cable and the selected printer. |
| Barcode does not scan | Print a new label (`L` on the product); use the Code 128 value shown under the bars. |
| Change not syncing | Check the top bar/banner and Settings → Sync; the till keeps working offline. |
| Forgot to close yesterday | Open Day close; the period simply continues and covers both days. |
| Need a new till | Settings → Devices → New device; use the code on the new browser. |
| Need help | Settings → About shows the version; contact Algovyn with the shop name and a screenshot (never send PINs, codes or full exports). |
