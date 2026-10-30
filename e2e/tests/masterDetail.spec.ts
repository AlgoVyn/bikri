import { expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalScroll, openReadyShop } from './helpers.ts';

// The reference app keeps the list beside the selected row on desktop (screens 08/10/12/13).

async function seedManyProducts(page: Page): Promise<void> {
  await openReadyShop(page, '/bikri/products');
  await page.evaluate(
    (products) => window.__bikriTest?.seedProducts(products),
    Array.from({ length: 40 }, (_, i) => ({
      name: `Product ${String(i + 1).padStart(2, '0')}`,
      price: 100000 + i * 1000,
      stock: 10,
    })),
  );
  await expect(page.getByTestId('products-master')).toBeVisible();
}
test.describe('desktop master–detail', () => {
  test.beforeEach(({ browserName: _b }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop layout');
  });

  test('sales: a bill opens beside the list', async ({ page }) => {
    await openReadyShop(page, '/bikri/sales');
    await page.evaluate(async () => {
      await window.__bikriTest?.seedTodaySales();
    });
    await expect(page.getByText('Select a bill')).toHaveCount(0);
    await page.getByRole('link', { name: /A-A-1/ }).click();
    await expect(page.getByTestId('sales-detail')).toBeVisible();
    await expect(page.getByTestId('sales-master')).toBeVisible();
    await expect(page.getByText('Select a bill')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('products: a product opens beside the list', async ({ page }) => {
    await openReadyShop(page, '/bikri/products');
    await page.evaluate(async () => {
      await window.__bikriTest?.seedProducts([
        { name: 'Samsung Galaxy A15 128GB', price: 5899900, stock: 12 },
      ]);
    });
    await expect(page.getByText('Select a product')).toHaveCount(0);
    await page.getByRole('link', { name: /Samsung Galaxy A15/ }).click();
    await expect(page.getByTestId('products-detail')).toBeVisible();
    await expect(page.getByTestId('products-master')).toBeVisible();
    await expect(page.getByText('Select a product')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('products: selecting a row deep in the list keeps the scroll position', async ({
    page,
  }) => {
    await seedManyProducts(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await page.locator('main a[href*="/products/"]').last().click();
    await expect(page.getByTestId('products-detail')).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const detail = await page.getByTestId('products-detail').boundingBox();
    expect(detail?.y ?? 999).toBeLessThan(200);
  });

  test('udhaar: a customer khata opens beside the list', async ({ page }) => {
    await openReadyShop(page, '/bikri/udhaar');
    await page.evaluate(async () => {
      await window.__bikriTest?.seedCustomer({
        name: 'Bilal Ahmed',
        phone: '03001234567',
        balance: 125000,
      });
    });
    await expect(page.getByText('Select a customer')).toHaveCount(0);
    await page.getByRole('link', { name: /Bilal Ahmed/ }).click();
    await expect(page.getByTestId('udhaar-detail')).toBeVisible();
    await expect(page.getByTestId('udhaar-master')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('suppliers: a ledger opens beside the list', async ({ page }) => {
    await openReadyShop(page, '/bikri/suppliers');
    await page.evaluate(async () => {
      await window.__bikriTest?.seedSupplier({
        name: 'Karachi Traders',
        phone: '03211234567',
      });
    });
    await expect(page.getByText('Select a supplier')).toHaveCount(0);
    await page.getByRole('link', { name: /Karachi Traders/ }).click();
    await expect(page.getByTestId('suppliers-detail')).toBeVisible();
    await expect(page.getByTestId('suppliers-master')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test('phone products: selecting a row opens the detail at the top', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await seedManyProducts(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.locator('main a[href*="/products/"]').last().click();
  await expect(page.getByTestId('products-detail')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('phone sales: one pane at a time', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout');
  await openReadyShop(page, '/bikri/sales');
  await page.evaluate(async () => {
    await window.__bikriTest?.seedTodaySales();
  });
  await expect(page.getByText('Select a bill')).toBeHidden();
  await page.getByRole('link', { name: /A-A-1/ }).click();
  await expect(page.getByTestId('sales-detail')).toBeVisible();
  await expect(page.getByTestId('sales-master')).toBeHidden();
  await expect(page.getByRole('link', { name: 'Back to sales' })).toBeVisible();
});

test('1024: the list and detail become one pane each', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one 1024 pass is enough');
  await page.setViewportSize({ width: 1024, height: 768 });
  await openReadyShop(page, '/bikri/sales');
  await page.evaluate(async () => {
    await window.__bikriTest?.seedTodaySales();
  });
  await expect(page.getByText('Select a bill')).toBeHidden();
  await page.getByRole('link', { name: /A-A-1/ }).click();
  await expect(page.getByTestId('sales-detail')).toBeVisible();
  await expect(page.getByTestId('sales-master')).toBeHidden();
  await expect(page.getByRole('link', { name: 'Back to sales' })).toBeVisible();
});
