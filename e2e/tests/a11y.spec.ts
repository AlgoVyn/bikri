import { expect, test } from '@playwright/test';
import { expectNoSeriousAxe, idbAll, openReadyShop } from './helpers.ts';

// T-063: axe on every screen (08 §8), English and the Urdu core journey.

type Row = { id: string };

async function prepare(page: import('@playwright/test').Page) {
  await openReadyShop(page, '/bikri/');
  const [productId] =
    (await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Cable', name_ur: 'کیبل', price: 50000, stock: 4 },
      ]),
    )) ?? [];
  await page.evaluate(() => window.__bikriTest?.seedTodaySales());
  const sales = await idbAll<Row>(page, 'sales');
  const customers = await idbAll<Row>(page, 'customers');
  if (!productId || !sales[0] || !customers[0]) throw new Error('seed failed');
  return { productId, saleId: sales[0].id, customerId: customers[0].id };
}

test.describe('accessibility sweep (T-063)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('English: every route has no serious or critical axe violation', async ({
    page,
  }) => {
    const { productId, saleId, customerId } = await prepare(page);
    const routes: Array<[string, string]> = [
      ['Home', '/bikri/'],
      ['Sell', '/bikri/sell'],
      ['Products', '/bikri/products'],
      ['Product detail', `/bikri/products/${productId}`],
      ['Product edit', `/bikri/products/${productId}/edit`],
      ['Product form', '/bikri/products/new'],
      ['Categories', '/bikri/products/categories'],
      ['Import', '/bikri/products/import'],
      ['Prices', '/bikri/products/prices'],
      ['Sales', '/bikri/sales'],
      ['Bill detail', `/bikri/sales/${saleId}`],
      ['Refund', `/bikri/sales/${saleId}/refund`],
      ['Udhaar', '/bikri/udhaar'],
      ['Customer', `/bikri/udhaar/${customerId}`],
      ['Chase', '/bikri/udhaar/chase'],
      ['Suppliers', '/bikri/suppliers'],
      ['Expenses', '/bikri/expenses'],
      ['Day close', '/bikri/day-close'],
      ['Reports', '/bikri/reports'],
      ['Settings', '/bikri/settings'],
      ['Shop settings', '/bikri/settings/shop'],
      ['Cashiers', '/bikri/settings/cashiers'],
      ['Activity', '/bikri/settings/activity'],
      ['Labels settings', '/bikri/settings/labels'],
      ['Backup', '/bikri/settings/backup'],
      ['Display', '/bikri/settings/display'],
      ['Printer', '/bikri/settings/printer'],
      ['About', '/bikri/settings/about'],
    ];
    for (const [name, path] of routes) {
      await page.evaluate((to) => window.__bikriTest?.navigate(to), path);
      await expect(page.locator('main')).toBeVisible();
      await expectNoSeriousAxe(page);
      test.info().annotations.push({ type: 'route', description: name });
    }
  });

  test('Urdu: core selling and back-office screens', async ({ page }) => {
    const { productId, saleId, customerId } = await prepare(page);
    await page.getByLabel('Language').selectOption('ur');
    const routes: Array<[string, string]> = [
      ['Home', '/bikri/'],
      ['Sell', '/bikri/sell'],
      ['Product detail', `/bikri/products/${productId}`],
      ['Sales', '/bikri/sales'],
      ['Bill detail', `/bikri/sales/${saleId}`],
      ['Udhaar', '/bikri/udhaar'],
      ['Customer', `/bikri/udhaar/${customerId}`],
      ['Expenses', '/bikri/expenses'],
      ['Day close', '/bikri/day-close'],
      ['Reports', '/bikri/reports'],
      ['Settings', '/bikri/settings'],
      ['Shop settings', '/bikri/settings/shop'],
    ];
    for (const [name, path] of routes) {
      await page.evaluate((to) => window.__bikriTest?.navigate(to), path);
      await expect(page.locator('main')).toBeVisible();
      await expectNoSeriousAxe(page);
      test.info().annotations.push({ type: 'route', description: name });
    }
  });
});
