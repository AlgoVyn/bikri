import { businessDate, newId, type Role } from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import { csvCell, rupeesCsv } from '../lib/csv.ts';
import type { TableSource } from './caches.ts';
import type { LedgerContext } from './products.ts';
import { writeAction } from './write.ts';

const n = (v: unknown): number => Number(v ?? 0);
export const CASHIER_EXPENSE_LIMIT = 200_000;

export type ExpenseMethod = 'cash' | 'card' | 'bank_wallet';
export type ExpenseRow = {
  expense: SyncedRow;
  category: MasterRow | null;
  staffName: string;
  deviceName: string;
  reversed: boolean;
};
export type ExpenseDay = { date: string; total: number; rows: ExpenseRow[] };
export type CategoryTotal = { category: MasterRow | null; net: number };
export type ExpenseList = {
  rows: ExpenseRow[];
  days: ExpenseDay[];
  byCategory: CategoryTotal[];
  total: number;
};

export class ExpenseError extends Error {
  readonly code:
    | 'amount'
    | 'category'
    | 'method'
    | 'date'
    | 'owner'
    | 'limit'
    | 'missing'
    | 'already'
    | 'same_day'
    | 'reason';
  constructor(code: ExpenseError['code']) {
    super(code);
    this.name = 'ExpenseError';
    this.code = code;
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Expenses for one range with the category totals (screens/14). */
export async function expenseList(
  src: TableSource,
  range: { from: string; to: string },
): Promise<ExpenseList> {
  const expenses = (
    await (src.table('expenses') as Table<SyncedRow>)
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).sort(
    (a, b) =>
      n(b.created_at) - n(a.created_at) ||
      String(b.id).localeCompare(String(a.id)),
  );
  const categories = new Map(
    (await (src.table('expense_categories') as Table<MasterRow>).toArray()).map(
      (c) => [c.id, c],
    ),
  );
  const staff = new Map(
    (
      await (src.table('staff') as Table<MasterRow>).bulkGet([
        ...new Set(expenses.map((e) => String(e.staff_id))),
      ])
    )
      .filter((s): s is MasterRow => s !== undefined)
      .map((s) => [s.id, s]),
  );
  const devices = new Map(
    (
      await (src.table('devices') as Table<SyncedRow>).bulkGet([
        ...new Set(expenses.map((e) => String(e.device_id))),
      ])
    )
      .filter((d): d is SyncedRow => d !== undefined)
      .map((d) => [d.id, d]),
  );
  const reversed = new Set(
    expenses.map((e) => e.reverses_id).filter((id): id is string => !!id),
  );
  const rows: ExpenseRow[] = expenses.map((expense) => {
    const category = categories.get(String(expense.category_id)) ?? null;
    const device = devices.get(String(expense.device_id));
    return {
      expense,
      category,
      staffName: staff.get(String(expense.staff_id))?.name
        ? String(staff.get(String(expense.staff_id))?.name)
        : '',
      deviceName: device ? String(device.name ?? device.code ?? '') : '',
      reversed: reversed.has(expense.id),
    };
  });

  const byCategoryMap = new Map<string, number>();
  for (const row of rows) {
    const key = String(row.expense.category_id);
    const amount = n(row.expense.amount) * (row.expense.reverses_id ? -1 : 1);
    byCategoryMap.set(key, (byCategoryMap.get(key) ?? 0) + amount);
  }
  const byCategory = [...byCategoryMap]
    .map(([id, net]) => ({ category: categories.get(id) ?? null, net }))
    .filter((row) => row.net !== 0)
    .sort((a, b) => b.net - a.net);

  // Group by business date, not by adjacent created_at: reversing an old expense must not
  // split one day into two sections.
  const byDay = new Map<string, ExpenseDay>();
  for (const row of rows) {
    const date = String(row.expense.business_date);
    const amount = n(row.expense.amount) * (row.expense.reverses_id ? -1 : 1);
    const day = byDay.get(date) ?? { date, total: 0, rows: [] };
    day.total += amount;
    day.rows.push(row);
    byDay.set(date, day);
  }
  const days = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
  return {
    rows,
    days,
    byCategory,
    total: rows.reduce(
      (sum, row) =>
        sum + n(row.expense.amount) * (row.expense.reverses_id ? -1 : 1),
      0,
    ),
  };
}

export function expensesCsv(
  rows: readonly ExpenseRow[],
  timeZone: string,
): string {
  const header = [
    'date',
    'category',
    'payee',
    'note',
    'amount',
    'method',
    'staff',
    'device',
  ];
  return [header.join(',')]
    .concat(
      rows.map((row) =>
        [
          String(row.expense.business_date),
          row.category ? String(row.category.name_en) : '',
          String(row.expense.payee ?? ''),
          String(row.expense.note ?? ''),
          rupeesCsv(n(row.expense.amount) * (row.expense.reverses_id ? -1 : 1)),
          String(row.expense.method),
          row.staffName,
          row.deviceName,
        ]
          .map(csvCell)
          .join(','),
      ),
    )
    .join('\r\n');
}

export async function expenseCategories(
  src: TableSource,
): Promise<MasterRow[]> {
  return (await (src.table('expense_categories') as Table<MasterRow>).toArray())
    .filter((c) => !c.deleted_at)
    .sort((a, b) => n(a.sort_order) - n(b.sort_order));
}

export type ExpenseInput = {
  expenseId: string;
  categoryId: string;
  amount: number;
  method: ExpenseMethod;
  payee?: string;
  note?: string;
  date: string;
};

export type ExpenseOptions = {
  role: Role;
  today: string;
  now?: number;
  override?: { approved_by: string } | null;
};

/** Adds an expense; a cashier is limited to cash ≤ Rs 2,000 unless a manager approves. */
export async function createExpense(
  db: BikriDb,
  input: ExpenseInput,
  ctx: LedgerContext,
  options: ExpenseOptions,
): Promise<SyncedRow> {
  const existing = await db.expenses.get(input.expenseId);
  if (existing) return existing;
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new ExpenseError('amount');
  if (!['cash', 'card', 'bank_wallet'].includes(input.method))
    throw new ExpenseError('method');
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.date) ||
    input.date > options.today ||
    input.date < addDays(options.today, -30)
  )
    throw new ExpenseError('date');
  if (options.role !== 'owner' && input.date !== options.today)
    throw new ExpenseError('owner');
  const category = await db.expense_categories.get(input.categoryId);
  if (!category || category.deleted_at) throw new ExpenseError('category');
  if (
    options.role === 'cashier' &&
    !options.override &&
    (input.method !== 'cash' || input.amount > CASHIER_EXPENSE_LIMIT)
  )
    throw new ExpenseError('limit');
  const now = options.now ?? Date.now();
  return writeAction(
    db,
    async (w) => {
      const row: SyncedRow = {
        id: input.expenseId,
        category_id: input.categoryId,
        amount: input.amount,
        method: input.method,
        payee: (input.payee ?? '').trim().slice(0, 60),
        note: (input.note ?? '').trim().slice(0, 120),
        reverses_id: null,
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: input.date,
        created_at: now,
      };
      await w.insert('expenses', row);
      if (options.override)
        await w.insert('audit_log', {
          id: newId(now),
          action: 'override',
          entity: 'expenses',
          entity_id: input.expenseId,
          before_json: null,
          after_json: JSON.stringify({
            permission: 'expense.create',
            approved_by: options.override.approved_by,
          }),
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          created_at: now,
        });
      return row;
    },
    { now, actor: ctx.staff_id },
  );
}

/** Reverses an expense with a second, negative row (append-only). */
export async function reverseExpense(
  db: BikriDb,
  input: { expenseId: string; reversalId: string },
  ctx: LedgerContext,
  options: { role: Role; today: string; now?: number },
): Promise<SyncedRow> {
  const original = await db.expenses.get(input.expenseId);
  if (!original) throw new ExpenseError('missing');
  if (original.reverses_id) throw new ExpenseError('already');
  const existing = await db.expenses
    .filter((e) => e.reverses_id === input.expenseId)
    .first();
  if (existing) throw new ExpenseError('already');
  if (
    options.role === 'cashier' &&
    String(original.business_date) !== options.today
  )
    throw new ExpenseError('same_day');
  const now = options.now ?? Date.now();
  return writeAction(
    db,
    (w) =>
      w.insert('expenses', {
        id: input.reversalId,
        category_id: String(original.category_id),
        amount: n(original.amount),
        method: String(original.method),
        payee: String(original.payee ?? ''),
        note: String(original.note ?? ''),
        reverses_id: input.expenseId,
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: String(original.business_date),
        created_at: now,
      }),
    { now, actor: ctx.staff_id },
  );
}

export type CashMoveInput = {
  cashMoveId: string;
  kind: 'pay_in' | 'pay_out';
  amount: number;
  reason: string;
};

/** Pay-in / pay-out (screens/14), appended to cash_moves. */
export async function cashMove(
  db: BikriDb,
  input: CashMoveInput,
  ctx: LedgerContext,
  now = Date.now(),
): Promise<SyncedRow> {
  const existing = await db.cash_moves.get(input.cashMoveId);
  if (existing) return existing;
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new ExpenseError('amount');
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 120)
    throw new ExpenseError('reason');
  return writeAction(
    db,
    (w) =>
      w.insert('cash_moves', {
        id: input.cashMoveId,
        kind: input.kind,
        amount: input.amount,
        reason,
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: businessDate(now, ctx.timeZone),
        created_at: now,
      }),
    { now, actor: ctx.staff_id },
  );
}

/** Owner-created expense category (screens/14 + Category). */
export async function createExpenseCategory(
  db: BikriDb,
  input: { name: string; nameUr?: string },
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  const name = input.name.trim().slice(0, 40);
  if (!name) throw new RangeError('name is required');
  const code =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 30) || `cat_${now.toString(36)}`;
  const existing = await db.expense_categories
    .where('code')
    .equals(code)
    .first();
  if (existing) throw new RangeError('category exists');
  return writeAction(
    db,
    (w) =>
      w.create('expense_categories', {
        code,
        name_en: name,
        name_ur: (input.nameUr ?? '').trim().slice(0, 40),
        icon: 'receipt',
        is_system: 0,
        sort_order: 50,
      }),
    { now, actor },
  );
}

/** Day-close helper: expenses net of reversals in a device period. */
export function expenseNet(rows: readonly SyncedRow[]): number {
  return rows.reduce(
    (sum, row) => sum + n(row.amount) * (row.reverses_id ? -1 : 1),
    0,
  );
}
