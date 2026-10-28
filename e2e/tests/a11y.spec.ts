import { expect, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  expectNoSeriousAxe,
  idbAll,
  openReadyShop,
} from './helpers.ts';

// T-063: axe on every screen (08 §8), English and the Urdu core journey.

type Row = { id: string };
type Route = [name: string, path: string];

async function prepare(page: import('@playwright/test').Page) {
  await openReadyShop(page, '/bikri/');
  const [productId] =
    (await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Cable', name_ur: 'کیبل', price: 50000, stock: 4 },
      ]),
    )) ?? [];
  const supplierId = await page.evaluate(() => {
    const hooks = window.__bikriTest as unknown as {
      seedSupplier?: (s: { name: string; opening?: number }) => Promise<string>;
    };
    return hooks.seedSupplier?.({ name: 'Hall Road', opening: 100000 });
  });
  await page.evaluate(() => window.__bikriTest?.seedTodaySales());
  const sales = await idbAll<Row>(page, 'sales');
  const customers = await idbAll<Row>(page, 'customers');
  if (!productId || !supplierId || !sales[0] || !customers[0])
    throw new Error('seed failed');
  return {
    productId,
    supplierId,
    saleId: sales[0].id,
    customerId: customers[0].id,
  };
}

async function visit(page: import('@playwright/test').Page, path: string) {
  // `navigate` is router-relative: the router already has basepath `/bikri`.
  await page.evaluate((to) => window.__bikriTest?.navigate(to), path);
  const expected = path === '/' ? '/bikri/' : `/bikri${path}`;
  await expect
    .poll(() => new URL(page.url()).pathname, { message: path })
    .toBe(expected);
  await expect(page.getByText('This page is not available.')).toHaveCount(0);
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('main')).not.toBeEmpty();
  await expectNoHorizontalScroll(page);
}

test.describe('accessibility sweep (T-063)', () => {
  test.describe.configure({ timeout: 180_000 });

  test('English: every route has no serious or critical axe violation', async ({
    page,
  }) => {
    const { productId, supplierId, saleId, customerId } = await prepare(page);
    const routes: Route[] = [
      ['Home', '/'],
      ['Sell', '/sell'],
      ['Products', '/products'],
      ['Product detail', `/products/${productId}`],
      ['Product edit', `/products/${productId}/edit`],
      ['Product adjust', `/products/${productId}/adjust`],
      ['Product form', '/products/new'],
      ['Suggested products', '/products/suggested'],
      ['Categories', '/products/categories'],
      ['Import', '/products/import'],
      ['Prices', '/products/prices'],
      ['Stock count', '/stock/count'],
      ['Sales', '/sales'],
      ['Bill detail', `/sales/${saleId}`],
      ['Refund', `/sales/${saleId}/refund`],
      ['Udhaar', '/udhaar'],
      ['Customer', `/udhaar/${customerId}`],
      ['Chase', '/udhaar/chase'],
      ['Suppliers', '/suppliers'],
      ['Supplier', `/suppliers/${supplierId}`],
      ['Delivery', `/suppliers/${supplierId}/delivery/new`],
      ['Return to supplier', `/suppliers/${supplierId}/return/new`],
      ['Expenses', '/expenses'],
      ['Day close', '/day-close'],
      ['Reports', '/reports'],
      ['Settings', '/settings'],
      ['Shop settings', '/settings/shop'],
      ['Cashiers', '/settings/cashiers'],
      ['Activity', '/settings/activity'],
      ['Devices', '/settings/devices'],
      ['Sync', '/settings/sync'],
      ['Labels settings', '/settings/labels'],
      ['Backup', '/settings/backup'],
      ['Display', '/settings/display'],
      ['Printer', '/settings/printer'],
      ['About', '/settings/about'],
    ];
    for (const [name, path] of routes) {
      await visit(page, path);
      await expectNoSeriousAxe(page);
      test.info().annotations.push({ type: 'route', description: name });
    }

    await page.evaluate(() => window.__bikriTest?.navigate('/labels'));
    await expect(
      page.getByRole('dialog', { name: 'Print labels' }),
    ).toBeVisible();
    await expectNoSeriousAxe(page);
  });

  test('read-only and support banners', async ({ page }) => {
    await prepare(page);
    await page.evaluate(async () => {
      await window.__bikriTest?.setKv('tenant_status', {
        status: 'read_only',
        since: 1,
      });
      await window.__bikriTest?.setKv('support', {
        until: Date.now() + 3_600_000,
        reason: 'Accessibility review',
      });
    });
    await visit(page, '/');
    await expect(page.getByTestId('banner-read-only')).toBeVisible();
    await expect(page.getByTestId('banner-support')).toBeVisible();
    await expectNoSeriousAxe(page);
  });

  test('Urdu: core selling and back-office screens', async ({ page }) => {
    const { productId, supplierId, saleId, customerId } = await prepare(page);
    await page.getByLabel('Language').selectOption('ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ur');
    const routes: Route[] = [
      ['Home', '/'],
      ['Sell', '/sell'],
      ['Product detail', `/products/${productId}`],
      ['Sales', '/sales'],
      ['Bill detail', `/sales/${saleId}`],
      ['Udhaar', '/udhaar'],
      ['Customer', `/udhaar/${customerId}`],
      ['Suppliers', '/suppliers'],
      ['Supplier', `/suppliers/${supplierId}`],
      ['Expenses', '/expenses'],
      ['Day close', '/day-close'],
      ['Reports', '/reports'],
      ['Settings', '/settings'],
      ['Shop settings', '/settings/shop'],
    ];
    for (const [name, path] of routes) {
      await visit(page, path);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expectNoSeriousAxe(page);
      test.info().annotations.push({ type: 'route', description: name });
    }
  });
});
