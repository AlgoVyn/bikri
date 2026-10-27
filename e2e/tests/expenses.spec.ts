import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { idbAll, openReadyShop } from './helpers.ts';

// T-046: expenses, reversal and cash in/out (screens/14 ACs 1–4).

const dialog = (page: Page, name: string | RegExp) =>
  page.getByRole('dialog', { name });

async function addExpense(
  page: Page,
  input: { category?: string; amount: string; method?: string; payee?: string },
) {
  await page
    .getByRole('button', { name: /New expense/ })
    .first()
    .click();
  const d = dialog(page, 'New expense');
  await d
    .getByRole('button', { name: input.category ?? 'Tea & snacks' })
    .click();
  await d.getByLabel('Amount').fill(input.amount);
  if (input.payee) await d.getByLabel('Payee (optional)').fill(input.payee);
  if (input.method) await d.getByRole('button', { name: input.method }).click();
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(d).toHaveCount(0);
}

test.describe('Expenses (T-046)', () => {
  test('AC 1, 2, 4: cash changes expected cash, bank does not, CSV header, reversal and cash in', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/expenses');
    await addExpense(page, { amount: '300', payee: 'Tea shop' });
    await addExpense(page, { amount: '500', method: 'Bank/wallet' });
    await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Something', price: 10000, stock: 1 },
      ]),
    );
    await page.goto('/bikri/');
    await expect(page.getByTestId('today-cash')).toContainText('300');
    await expect(page.getByTestId('today-cash')).not.toContainText('800');

    await page.goto('/bikri/expenses');
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const text = await readFile((await csv.path()) ?? '', 'utf8');
    expect(text).toContain(
      'date,category,payee,note,amount,method,staff,device',
    );
    expect(text).toContain('Tea shop');

    await page.getByRole('button', { name: 'Cash in / out' }).click();
    const cash = dialog(page, 'Cash in / out');
    await cash.getByLabel('Amount').fill('500');
    await cash.getByLabel('Reason').fill('Change float from bank');
    await cash.getByRole('button', { name: 'Save' }).click();
    await expect(cash).toHaveCount(0);
    const moves = await idbAll<{
      kind: string;
      amount: number;
      reason: string;
    }>(page, 'cash_moves');
    expect(moves).toMatchObject([
      { kind: 'pay_in', amount: 50000, reason: 'Change float from bank' },
    ]);

    const cashRow = page
      .getByTestId('expense-row')
      .filter({ hasText: 'Tea shop' });
    await cashRow.getByRole('button', { name: 'Reverse' }).click();
    const confirm = dialog(page, 'Reverse this expense?');
    await confirm.getByRole('button', { name: 'Reverse' }).click();
    await expect(page.getByText('Reversed').first()).toBeVisible();
    const all = await idbAll<{ reverses_id: string | null }>(page, 'expenses');
    expect(all.filter((e) => e.reverses_id)).toHaveLength(1);
  });

  test('AC 3: a cashier over Rs 2,000 sees the limit and the manager option', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/expenses');
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier'));
    await page
      .getByRole('button', { name: /New expense/ })
      .first()
      .click();
    const d = dialog(page, 'New expense');
    await d.getByRole('button', { name: 'Rent' }).click();
    await d.getByLabel('Amount').fill('2500');
    await expect(
      d.getByText('A cashier can record cash expenses up to Rs 2,000.'),
    ).toBeVisible();
    await expect(
      d.getByRole('button', { name: 'Ask a manager' }),
    ).toBeVisible();
    await expect(d.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('Urdu expense form', async ({ page }) => {
    await openReadyShop(page, '/bikri/expenses');
    await page.getByLabel('Language').selectOption('ur');
    await page
      .getByRole('button', { name: /نیا خرچ/ })
      .first()
      .click();
    const d = dialog(page, 'نیا خرچ');
    await expect(d.getByText('قسم', { exact: true })).toBeVisible();
    await expect(d.getByLabel('رقم')).toBeVisible();
  });
});
