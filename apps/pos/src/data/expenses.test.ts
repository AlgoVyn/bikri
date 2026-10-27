import { businessDate } from '@bikri/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ledgerContext } from './catalog.ts';
import {
  cashMove,
  createExpense,
  createExpenseCategory,
  ExpenseError,
  expenseCategories,
  expenseList,
  expensesCsv,
  reverseExpense,
} from './expenses.ts';
import { expectedCash } from './reports.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, readyDb } from './testShop.ts';

afterEach(dropTestDbs);

const TZ = 'Asia/Karachi';
const TODAY = businessDate(NOW, TZ);

async function setup(prefix = 'expenses') {
  const db = await readyDb(prefix);
  await addShop(db, { name: 'Bikri', timezone: TZ });
  const ctx = await ledgerContext(db, 'st-1');
  return { db, ctx };
}

describe('expenses and cash moves (T-046)', () => {
  it('AC 1/2: a cash expense reduces expected cash, a bank expense does not', async () => {
    const { db, ctx } = await setup();
    await createExpense(
      db,
      {
        expenseId: 'cash-expense',
        categoryId: 'ec-1',
        amount: 30000,
        method: 'cash',
        payee: 'Tea shop',
        note: 'Tea & snacks',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 1000 },
    );
    expect(await expectedCash(db, 'dev-1', NOW + 2000)).toBe(-30000);
    await createExpense(
      db,
      {
        expenseId: 'bank-expense',
        categoryId: 'ec-1',
        amount: 50000,
        method: 'bank_wallet',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 3000 },
    );
    expect(await expectedCash(db, 'dev-1', NOW + 4000)).toBe(-30000);
    const list = await expenseList(db, { from: TODAY, to: TODAY });
    expect(list.total).toBe(80000);
    expect(list.byCategory).toMatchObject([{ net: 80000 }]);
    expect(list.days).toHaveLength(1);
  });

  it('AC 3: a cashier over Rs 2,000 needs the manager override', async () => {
    const { db, ctx } = await setup('limit');
    await expect(
      createExpense(
        db,
        {
          expenseId: 'big',
          categoryId: 'ec-1',
          amount: 250000,
          method: 'cash',
          date: TODAY,
        },
        ctx,
        { role: 'cashier', today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'limit' });
    await expect(
      createExpense(
        db,
        {
          expenseId: 'bank',
          categoryId: 'ec-1',
          amount: 100,
          method: 'bank_wallet',
          date: TODAY,
        },
        ctx,
        { role: 'cashier', today: TODAY, now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'limit' });
    const allowed = await createExpense(
      db,
      {
        expenseId: 'big-override',
        categoryId: 'ec-1',
        amount: 250000,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      {
        role: 'cashier',
        today: TODAY,
        now: NOW + 1000,
        override: { approved_by: 'st-1' },
      },
    );
    expect(allowed.id).toBe('big-override');
    expect(
      await db.audit_log
        .where('[entity+entity_id]')
        .equals(['expenses', 'big-override'])
        .toArray(),
    ).toMatchObject([{ action: 'override' }]);
  });

  it('AC 4: exports the documented month CSV header', async () => {
    const { db, ctx } = await setup('csv');
    await createExpense(
      db,
      {
        expenseId: 'csv-expense',
        categoryId: 'ec-1',
        amount: 30000,
        method: 'cash',
        payee: 'Tea shop',
        note: 'Tea, snacks',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 1000 },
    );
    const list = await expenseList(db, {
      from: `${TODAY.slice(0, 7)}-01`,
      to: `${TODAY.slice(0, 7)}-31`,
    });
    const csv = expensesCsv(list.rows, TZ);
    expect(csv.split('\r\n')[0]).toBe(
      'date,category,payee,note,amount,method,staff,device',
    );
    expect(csv).toContain('Tea shop');
    expect(csv).toContain('"Tea, snacks"');
  });

  it('reverses once; a cashier may reverse only same-day expenses', async () => {
    const { db, ctx } = await setup('reverse');
    const original = await createExpense(
      db,
      {
        expenseId: 'reverse-expense',
        categoryId: 'ec-1',
        amount: 30000,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 1000 },
    );
    await reverseExpense(
      db,
      { expenseId: original.id, reversalId: 'reversal-1' },
      ctx,
      { role: 'cashier', today: TODAY, now: NOW + 2000 },
    );
    const list = await expenseList(db, { from: TODAY, to: TODAY });
    expect(list.total).toBe(0);
    expect(list.byCategory).toEqual([]);
    expect(list.rows).toMatchObject([{ reversed: false }, { reversed: true }]);
    expect(await expectedCash(db, 'dev-1', NOW + 3000)).toBe(0);
    await expect(
      reverseExpense(
        db,
        { expenseId: original.id, reversalId: 'reversal-2' },
        ctx,
        { role: 'owner', today: TODAY, now: NOW + 4000 },
      ),
    ).rejects.toMatchObject({ code: 'already' });

    const old = await createExpense(
      db,
      {
        expenseId: 'old-expense',
        categoryId: 'ec-1',
        amount: 10000,
        method: 'cash',
        date: businessDate(NOW - 86_400_000, TZ),
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 5000 },
    );
    await expect(
      reverseExpense(
        db,
        { expenseId: old.id, reversalId: 'old-reversal' },
        ctx,
        { role: 'cashier', today: TODAY, now: NOW + 6000 },
      ),
    ).rejects.toMatchObject({ code: 'same_day' });
  });

  it('groups one business date together when an old expense is reversed later', async () => {
    const { db, ctx } = await setup('grouping');
    const yesterday = businessDate(NOW - 86_400_000, TZ);
    const old = await createExpense(
      db,
      {
        expenseId: 'group-old',
        categoryId: 'ec-1',
        amount: 10000,
        method: 'cash',
        date: yesterday,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 1000 },
    );
    await createExpense(
      db,
      {
        expenseId: 'group-today',
        categoryId: 'ec-1',
        amount: 20000,
        method: 'cash',
        date: TODAY,
      },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 2000 },
    );
    await reverseExpense(
      db,
      { expenseId: old.id, reversalId: 'group-reversal' },
      ctx,
      { role: 'owner', today: TODAY, now: NOW + 3000 },
    );
    const list = await expenseList(db, { from: yesterday, to: TODAY });
    expect(list.days.map((day) => day.date)).toEqual([TODAY, yesterday]);
    expect(list.days.find((day) => day.date === yesterday)?.total).toBe(0);
    expect(list.days.find((day) => day.date === TODAY)?.total).toBe(20000);
  });

  it('cash moves are appended and counted in expected cash', async () => {
    const { db, ctx } = await setup('cash');
    await cashMove(
      db,
      {
        cashMoveId: 'in-1',
        kind: 'pay_in',
        amount: 50000,
        reason: 'Change float from bank',
      },
      ctx,
      NOW + 1000,
    );
    await cashMove(
      db,
      {
        cashMoveId: 'out-1',
        kind: 'pay_out',
        amount: 20000,
        reason: 'Owner took cash home',
      },
      ctx,
      NOW + 2000,
    );
    expect(await expectedCash(db, 'dev-1', NOW + 3000)).toBe(30000);
    await expect(
      cashMove(
        db,
        { cashMoveId: 'bad', kind: 'pay_in', amount: 0, reason: 'x' },
        ctx,
        NOW,
      ),
    ).rejects.toBeInstanceOf(ExpenseError);
    await expect(
      cashMove(
        db,
        { cashMoveId: 'bad', kind: 'pay_in', amount: 100, reason: ' ' },
        ctx,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'reason' });
  });

  it('validates expenses and creates owner categories', async () => {
    const { db, ctx } = await setup('validation');
    const base = {
      expenseId: 'bad',
      categoryId: 'ec-1',
      amount: 100,
      method: 'cash' as const,
      date: TODAY,
    };
    await expect(
      createExpense(db, { ...base, amount: 0 }, ctx, {
        role: 'owner',
        today: TODAY,
      }),
    ).rejects.toMatchObject({ code: 'amount' });
    await expect(
      createExpense(db, { ...base, categoryId: 'missing' }, ctx, {
        role: 'owner',
        today: TODAY,
      }),
    ).rejects.toMatchObject({ code: 'category' });
    await expect(
      createExpense(db, { ...base, date: '2020-01-01' }, ctx, {
        role: 'owner',
        today: TODAY,
      }),
    ).rejects.toMatchObject({ code: 'date' });
    await expect(
      createExpense(
        db,
        { ...base, date: businessDate(NOW + 86_400_000, TZ) },
        ctx,
        {
          role: 'owner',
          today: TODAY,
        },
      ),
    ).rejects.toMatchObject({ code: 'date' });
    await expect(
      createExpense(
        db,
        { ...base, date: businessDate(NOW - 86_400_000, TZ) },
        ctx,
        {
          role: 'cashier',
          today: TODAY,
        },
      ),
    ).rejects.toMatchObject({ code: 'owner' });
    await expect(
      createExpense(db, { ...base, categoryId: 'ec-1', method: 'cash' }, ctx, {
        role: 'owner',
        today: TODAY,
      }),
    ).resolves.toBeDefined();
    const category = await createExpenseCategory(
      db,
      { name: 'Cleaning', nameUr: 'صفائی' },
      'st-1',
      NOW,
    );
    expect(category).toMatchObject({
      name_en: 'Cleaning',
      is_system: 0,
      code: 'cleaning',
    });
    expect((await expenseCategories(db)).map((c) => c.name_en)).toContain(
      'Cleaning',
    );
    await expect(
      createExpenseCategory(db, { name: 'Cleaning' }, 'st-1', NOW + 1000),
    ).rejects.toThrow();
  });
});
