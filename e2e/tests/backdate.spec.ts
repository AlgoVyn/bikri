import { expect, type Page, test } from '@playwright/test';
import { idbAll, idbPut, openReadyShop, setLanguage } from './helpers.ts';

type Row = Record<string, unknown>;

/** A cashier the owner can attribute the past sale to, without unlocking as them. */
async function addCashier(page: Page): Promise<void> {
  const now = Date.now();
  await idbPut(page, 'staff', {
    id: 'st-cashier',
    name: 'Sana',
    role: 'cashier',
    pin_hash: '',
    pin_salt: '',
    pin_iterations: 0,
    active: 1,
    max_discount_bp: 500,
    permissions_json: '{}',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    rev: 1,
  });
}

async function recordPastSale(page: Page, lang: 'en' | 'ur') {
  await openReadyShop(page, '/bikri/sales');
  if (lang === 'ur') await setLanguage(page, 'ur');
  await page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Earbuds', price: 350000, cost: 200000, stock: 5 },
    ]),
  );
  await addCashier(page);
  // A raw IndexedDB write is not seen by Dexie's liveQuery; reload so the dialog lists it.
  await page.reload();
  await expect(page.getByTestId('record-past-sale')).toBeVisible();

  await page.getByTestId('record-past-sale').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('backdate-preset-yesterday').click();
  const date = await dialog
    .getByTestId('backdate-selected-date')
    .getAttribute('data-date');
  expect(date).toBeTruthy();
  await expect(
    dialog.getByTestId('backdate-staff').locator('option'),
  ).toHaveCount(3);
  await dialog.getByTestId('backdate-staff').selectOption({ index: 2 });
  await dialog
    .getByTestId('backdate-reason')
    .fill('Cashier forgot to enter it');
  await expect(dialog.getByTestId('backdate-start')).toBeEnabled();
  await dialog.getByTestId('backdate-start').click();

  await page.getByTestId('sell-tile').filter({ hasText: 'Earbuds' }).click();
  // On phones the cart (and its banner) is a sheet behind the sticky cart bar.
  if ((page.viewportSize()?.width ?? 0) < 1024)
    await page.getByTestId('cart-bar').click();
  await expect(page.getByTestId('backdate-banner')).toBeVisible();
  await page.keyboard.press('F8');
  await page.getByTestId('pay-done').click();
  await expect(page.getByTestId('sale-backdated')).toBeVisible();

  const sales = await idbAll<Row>(page, 'sales');
  const sale = sales.find((row) => row.business_date === date);
  expect(sale).toMatchObject({
    business_date: date,
    staff_id: 'st-cashier',
  });
  // created_at is the entry time, not the chosen business date.
  expect(typeof sale?.created_at).toBe('number');
  expect(Number(sale?.created_at)).toBeGreaterThan(Date.now() - 10 * 60_000);
  expect(sale?.business_date).toBe(date);
  const audit = (await idbAll<Row>(page, 'audit_log')).find(
    (row) => row.action === 'sale_backdated',
  );
  expect(audit).toMatchObject({
    entity: 'sales',
    entity_id: sale?.id,
  });
  const staff = await idbAll<Row>(page, 'staff');
  const owner = staff.find((row) => row.role === 'owner');
  expect(audit?.staff_id).toBe(owner?.id);
  const after = JSON.parse(String(audit?.after_json ?? '{}')) as Row;
  expect(after).toMatchObject({
    attributed_staff_id: 'st-cashier',
    business_date: date,
    reason: 'Cashier forgot to enter it',
  });
}

test.describe('Record a past sale (D-173)', () => {
  test('English: owner records a missed sale on its real date and attributes the cashier', async ({
    page,
  }) => {
    await recordPastSale(page, 'en');
  });

  test('Urdu: owner records a missed sale on its real date and attributes the cashier', async ({
    page,
  }) => {
    await recordPastSale(page, 'ur');
  });
});
