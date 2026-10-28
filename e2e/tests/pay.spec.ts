import { expect, type Page, test } from '@playwright/test';
import { idbAll, openReadyShop } from './helpers.ts';

// T-017: Pay modal + sale recipe (screens/06 ACs 1–5, 7; screens/05 ACs 7–8 completion).

type Row = Record<string, unknown>;

async function sellWith(
  page: Page,
  products: { name: string; price: number; cost?: number; stock?: number }[],
) {
  await openReadyShop(page, '/bikri/sell');
  await page.evaluate(
    (list) => window.__bikriTest?.seedProducts(list),
    products,
  );
}

const tile = (page: Page, name: string) =>
  page.getByTestId('sell-tile').filter({ hasText: name });

async function t2(page: Page): Promise<void> {
  await sellWith(page, [
    { name: 'Galaxy A15', price: 4200000, cost: 3800000, stock: 3 },
    { name: 'Earbuds', price: 350000, cost: 200000, stock: 5 },
  ]);
  await tile(page, 'Galaxy A15').click();
  await tile(page, 'Earbuds').click();
  await page.keyboard.press('F3');
  const d = page.getByRole('dialog', { name: 'Bill discount' });
  await d.getByLabel('Discount', { exact: true }).fill('2500');
  await d.getByRole('button', { name: 'Apply' }).click();
  await expect(
    page.getByTestId('cart-bar').or(page.getByTestId('total-to-pay')).first(),
  ).toContainText('43,000');
}

const pay = (page: Page) => page.getByRole('dialog', { name: 'Take payment' });

test.describe('Pay (T-017)', () => {
  test('the close button leaves the pay sheet without saving', async ({
    page,
  }) => {
    await t2(page);
    await page.keyboard.press('F8');
    await expect(pay(page)).toBeVisible();
    await pay(page).getByRole('button', { name: 'Close dialog' }).click();
    await expect(pay(page)).toHaveCount(0);
    expect(await idbAll(page, 'sales')).toEqual([]);
  });

  test('AC 1: cash 50,000 on 43,000 gives change 7,000 and saves tendered/change; Esc first writes nothing', async ({
    page,
  }) => {
    await t2(page);
    await page.keyboard.press('F8');
    await expect(pay(page).getByTestId('pay-total')).toContainText('Rs 43,000');
    // AC 7: Esc closes without writing.
    await page.keyboard.press('Escape');
    await expect(pay(page)).toHaveCount(0);
    expect(await idbAll(page, 'sales')).toEqual([]);

    await page.keyboard.press('F8');
    await expect(pay(page).getByLabel('Received')).toHaveValue('43000');
    await expect(
      pay(page).getByRole('button', { name: 'Rs 45,000' }),
    ).toBeVisible();
    await pay(page).getByLabel('Received').fill('50000');
    await expect(pay(page).getByTestId('pay-change')).toHaveText(
      'Change to give Rs 7,000',
    );
    await pay(page).getByLabel('Received').fill('42600');
    await expect(pay(page).getByTestId('pay-due')).toHaveText(
      'Rs 400 still due',
    );
    await expect(pay(page).getByTestId('pay-done')).toBeDisabled();
    await pay(page).getByLabel('Received').fill('50000');
    await pay(page).getByTestId('pay-done').click();
    const done = page.getByRole('dialog', { name: 'Sale complete' });
    await expect(done.getByTestId('sale-saved')).toHaveText(
      'Sale saved · A-A-1',
    );
    await expect(done.getByTestId('done-change')).toHaveText(
      'Change to give Rs 7,000',
    );
    const [sale] = await idbAll<Row>(page, 'sales');
    expect(sale).toMatchObject({
      total: 4300000,
      cash_tendered: 5000000,
      change_given: 700000,
      paid_total: 4300000,
    });
    const payments = await idbAll<Row>(page, 'payments');
    expect(payments.map((p) => [p.method, p.amount])).toEqual([
      ['cash', 4300000],
    ]);
    await page.keyboard.press('Enter');
    await expect(done).toHaveCount(0);
    await expect(page.getByTestId('cart-line')).toHaveCount(0);
  });

  test('AC 2, 5: split cash + JazzCash TX123 saves two payments; Enter twice makes one sale', async ({
    page,
  }) => {
    await t2(page);
    await page.keyboard.press('F8');
    await pay(page).getByLabel('Received').fill('30000');
    await page.keyboard.press('Control+Enter');
    await pay(page)
      .getByRole('tab', { name: /Bank\/wallet/ })
      .click();
    await pay(page).getByRole('button', { name: 'JazzCash' }).click();
    await pay(page).getByLabel('Reference (optional)').fill('TX123');
    await expect(pay(page).getByLabel('Amount')).toHaveValue('13000');
    await expect(pay(page).getByTestId('pay-row')).toHaveCount(2);
    await expect(pay(page).getByTestId('pay-running')).toHaveText(
      'Paid Rs 43,000 · Remaining Rs 0',
    );
    await pay(page).getByLabel('Amount').press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sale-saved')).toBeVisible();
    expect(await idbAll(page, 'sales')).toHaveLength(1);
    const payments = await idbAll<Row>(page, 'payments');
    expect(
      payments.map((p) => [p.method, p.amount, p.reference, p.note]).sort(),
    ).toEqual([
      ['bank_wallet', 1300000, 'TX123', 'JazzCash'],
      ['cash', 3000000, '', ''],
    ]);
  });

  test('AC 3, 4: udhaar over a soft limit warns but completes; cash + udhaar adds exactly the udhaar part', async ({
    page,
  }) => {
    await t2(page);
    await page.evaluate(() =>
      window.__bikriTest?.seedCustomer({
        name: 'Ali',
        phone: '+923001112233',
        limit: 4000000,
        balance: 500000,
      }),
    );
    await page.keyboard.press('F8');
    await pay(page)
      .getByRole('tab', { name: /Udhaar/ })
      .click();
    await expect(
      pay(page).getByText('Choose a customer for udhaar'),
    ).toBeVisible();
    await expect(pay(page).getByTestId('pay-done')).toBeDisabled();
    await pay(page).getByRole('button', { name: 'Choose customer' }).click();
    await page
      .getByRole('dialog', { name: 'Customer' })
      .getByRole('button', { name: /^Ali/ })
      .click();
    await expect(pay(page).getByTestId('pay-credit')).toContainText(
      'Already owes Rs 5,000 · After this bill Rs 48,000 · Limit Rs 40,000',
    );
    await expect(pay(page).getByTestId('pay-credit')).toContainText(
      'Rs 8,000 over the limit of Rs 40,000',
    );
    await expect(pay(page).getByTestId('pay-done')).toHaveText(
      'Write Rs 43,000 in khata',
    );
    await pay(page).getByTestId('pay-done').click();
    await expect(page.getByTestId('done-udhaar')).toHaveText(
      "Rs 43,000 written in Ali's khata · now owes Rs 48,000",
    );
    await page.getByRole('button', { name: /New sale/ }).click();

    // AC 4: Rs 40,000 cash + Rs 3,000 udhaar.
    await tile(page, 'Galaxy A15').click();
    await tile(page, 'Earbuds').click();
    await page.keyboard.press('F3');
    const d = page.getByRole('dialog', { name: 'Bill discount' });
    await d.getByLabel('Discount', { exact: true }).fill('2500');
    await d.getByRole('button', { name: 'Apply' }).click();
    await page.keyboard.press('F8');
    await pay(page).getByLabel('Received').fill('40000');
    await page.keyboard.press('Control+Enter');
    await pay(page)
      .getByRole('tab', { name: /Udhaar/ })
      .click();
    await pay(page).getByRole('button', { name: 'Choose customer' }).click();
    await page
      .getByRole('dialog', { name: 'Customer' })
      .getByRole('button', { name: /^Ali/ })
      .click();
    await expect(pay(page).getByTestId('pay-done')).toHaveText(
      'Done — Rs 40,000 paid, Rs 3,000 in khata',
    );
    await pay(page).getByTestId('pay-done').click();
    await expect(page.getByTestId('done-udhaar')).toHaveText(
      "Rs 3,000 written in Ali's khata · now owes Rs 51,000",
    );
    const balances = await idbAll<Row>(page, 'party_balances');
    expect(balances.map((b) => b.balance)).toEqual([5100000]);
  });

  test('screens/05 AC 7, 8: selling past stock goes negative; quick sale moves no stock (Urdu)', async ({
    page,
  }) => {
    await sellWith(page, [
      { name: 'Galaxy A15', price: 4200000, cost: 3800000, stock: 1 },
    ]);
    await page.getByLabel('Language').selectOption('ur');
    await tile(page, 'Galaxy A15').click();
    await tile(page, 'Galaxy A15').click();
    await page.keyboard.press('F7');
    const q = page.getByRole('dialog', { name: 'فوری فروخت' });
    await q.getByLabel('تفصیل').fill('Repair labour');
    await q.getByLabel('قیمت').fill('500');
    await q.getByRole('button', { name: 'کارٹ میں ڈالیں' }).click();
    await page.keyboard.press('F8');
    const p = page.getByRole('dialog', { name: 'ادائیگی لیں' });
    await expect(p.getByTestId('pay-total')).toContainText('Rs 84,500');
    await p.getByTestId('pay-done').click();
    await expect(page.getByTestId('sale-saved')).toHaveText(
      'فروخت محفوظ · A-A-1',
    );
    const levels = await idbAll<Row>(page, 'stock_levels');
    expect(levels.map((l) => l.on_hand_milli)).toEqual([-1000]);
    const moves = await idbAll<Row>(page, 'stock_movements');
    expect(
      moves
        .filter((m) => m.reason_code === 'sale')
        .map((m) => m.qty_delta_milli),
    ).toEqual([-2000]);
    const lines = await idbAll<Row>(page, 'sale_lines');
    expect(lines.map((l) => [l.name_snapshot, l.product_id])).toEqual([
      ['Galaxy A15', expect.any(String)],
      ['Repair labour', null],
    ]);
    await page.getByLabel('زبان').selectOption('en');
  });
});
