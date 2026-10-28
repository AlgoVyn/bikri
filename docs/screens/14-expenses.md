# 14 — Expenses and cash in/out

**Route** `/expenses`. Permission `expense.create` (cashier: cash only, ≤ Rs 2,000 each), `cash.move` for pay-in/pay-out.

## Reference

| Dukaan | What to learn |
|---|---|
| ![Dukaan app-expenses](../reference/dukaan/app-expenses.png) | Expenses list with categories |
| ![Dukaan app-expenses-form](../reference/dukaan/app-expenses-form.png) | Expense form: category chips, amount, note |
| ![Dukaan app-expenses-saved](../reference/dukaan/app-expenses-saved.png) | Saved expense in the list |

## Layout

Top: date range Today / 7 days / 30 days / This month / Last month / Custom (from–to date fields), totals by category (horizontal bars), `+ Expense` (N), `Cash in / out`, `Export CSV`. The range is remembered on this device across navigation and reloads. List: time, category icon + name, payee, note, amount, method, staff. Grouped by business date.

## Expense form

| Field | Rules |
|---|---|
| Category | chips from `expense_categories` (seed: Electricity, Tea & snacks, Transport, Salary, Rent, Repairs, Internet & phone, Other); `+ Category` (owner). **No Supplier category** — a hint under the chips: "Paying a supplier? Use Suppliers → Pay supplier" |
| Amount | `MoneyInput` > 0; cashier max Rs 2,000 → "Ask a manager for bigger expenses" (override possible) |
| Method | Cash (default) / Bank-wallet / Card |
| Payee | optional 0–60 (suggestions from history) |
| Note | optional 0–120 |
| Date | today (owner can back-date 30 days) |

Expenses are append-only. Mistakes are fixed with `⋯ → Reverse` (same permission, same business date for cashiers): it writes a new `expenses` row with the same category, amount and method and `reverses_id` = the original; the list shows both struck through with "Reversed". Reversal rows count as negative in every total and in day close ([07 §8](../07-money-rules.md#8-day-close)). An expense can be reversed once.

## Cash in / out (pay-in / pay-out)

Dialog with tabs `Put cash in` / `Take cash out`; amount, reason (required 1–120: e.g. "Change float from bank", "Owner took cash home"). Writes `cash_moves`. Opens drawer. Shown in day close as Pay-ins / Pay-outs.

## Acceptance criteria

1. Cash expense Rs 300 "Tea & snacks" reduces that device's expected cash by Rs 300.
2. Bank-wallet expense does not change expected cash.
3. Cashier entering Rs 2,500 sees the limit message and the override option.
4. Category totals for a month export to CSV with columns `date,category,payee,note,amount,method,staff,device`.
