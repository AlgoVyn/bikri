import { expect, type Page, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  expectNoSeriousAxe,
  openReadyShop,
} from './helpers.ts';

// T-014: products list, detail, form, categories (screens/08 ACs 1, 2, 4, 7).

async function addCable(page: Page): Promise<void> {
  await page.goto('/bikri/products/new');
  await page.getByLabel('Name (English)').fill('Type-C cable 1 m white');
  await page.getByLabel('Brand').fill('Anker');
  await page.getByRole('button', { name: '+ New' }).click();
  await page.getByLabel('New category name').fill('Cables');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByLabel('Category', { exact: true })).toHaveValue(/.+/);
  await page.getByLabel('Barcode 1').fill('8901234567890');
  await page.getByLabel('Sale price').fill('1499');
  await page.getByLabel('Cost price').fill('1100');
  await page.getByLabel('Opening stock').fill('20');
  await page.getByLabel('Warranty', { exact: true }).selectOption('30');
  await page.getByRole('button', { name: /^Save Ctrl\+S$|^Save$/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Type-C cable 1 m white' }),
  ).toBeVisible();
}

test.describe('Products (T-014)', () => {
  test('English: add with opening stock, detail figures, duplicate, barcode clash, search, CSV', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/products');
    await expect(page.getByText('No products yet.')).toBeVisible();
    await expectNoSeriousAxe(page);
    await addCable(page);

    // AC 1: on hand 20, avg = last = Rs 1,100.
    await expect(page.getByTestId('detail-on-hand')).toContainText('20 pc');
    await expect(page.getByTestId('detail-avg-cost')).toContainText('Rs 1,100');
    await expect(page.getByTestId('detail-last-cost')).toContainText(
      'Rs 1,100',
    );
    await expect(page.getByTestId('detail-profit')).toContainText('Rs 399');
    await expect(page.getByTestId('detail-margin')).toContainText('26.6%');
    await expect(page.getByTestId('detail-stock-value')).toContainText(
      'Rs 22,000',
    );
    // Stock history: balance after the latest row equals on hand.
    await expect(page.getByTestId('history-balance').first()).toHaveText('20');
    await expect(
      page.getByRole('cell', { name: 'Opening stock' }),
    ).toBeVisible();
    await expectNoSeriousAxe(page);
    await expectNoHorizontalScroll(page);

    // AC 7: Duplicate keeps details, clears SKU, barcodes and opening stock.
    await page.getByRole('link', { name: 'Duplicate' }).click();
    const name = page.getByLabel('Name (English)');
    await expect(name).toHaveValue('Type-C cable 1 m white');
    await expect(name).toBeFocused();
    await expect(page.getByLabel('Brand')).toHaveValue('Anker');
    await expect(page.getByLabel('Sale price')).toHaveValue('1499');
    await expect(page.getByLabel('Cost price')).toHaveValue('1100');
    await expect(page.getByLabel('Warranty', { exact: true })).toHaveValue(
      '30',
    );
    await expect(page.getByLabel('SKU')).toHaveValue('');
    await expect(page.getByLabel('Barcode 1')).toHaveValue('');
    await expect(page.getByLabel('Opening stock')).toHaveValue('');
    await name.fill('Type-C cable 1 m black');
    await page.keyboard.press('Control+s');
    await expect(
      page.getByRole('heading', { name: 'Type-C cable 1 m black' }),
    ).toBeVisible();
    await expect(page.getByText('No stock movements yet.')).toBeVisible();

    // AC 2: the same barcode on another product is blocked with the owner's name.
    await page.goto('/bikri/products/new');
    await page.getByLabel('Name (English)').fill('Other cable');
    await page.getByLabel('Barcode 1').fill('8901234567890');
    await page.getByLabel('Sale price').fill('500');
    await page.getByRole('button', { name: /^Save/ }).last().click();
    await expect(
      page.getByText('Already used by Type-C cable 1 m white'),
    ).toBeVisible();
    await expect(page.getByLabel('Barcode 1')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Discard' }).click();

    // List: word search finds the variant; CSV has cost columns for the owner.
    await page.goto('/bikri/products');
    await expect(page.getByText('2 products')).toBeVisible();
    await page
      .getByLabel('Search products', { exact: true })
      .fill('cable white');
    await expect(page.getByText('1 product', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Type-C cable 1 m white/ }),
    ).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const csv = await (await download.createReadStream()).toArray();
    const text = Buffer.concat(csv).toString('utf8');
    expect(text.split('\r\n')[0]).toContain('cost,avg_cost');
    expect(text).toContain('Type-C cable 1 m white');
    await expectNoSeriousAxe(page);
    await expectNoHorizontalScroll(page);
  });

  test('Urdu: RTL form and list', async ({ page }) => {
    await openReadyShop(page, '/bikri/products/new');
    await page.getByLabel('Language').selectOption('ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { name: 'مصنوع شامل کریں' }),
    ).toBeVisible();
    await page.getByLabel('نام (انگریزی)').fill('Charger 20W');
    await page.getByLabel('نام (اردو)').fill('چارجر');
    await page.getByLabel('فروخت کی قیمت').fill('1200');
    await page.getByLabel('ابتدائی اسٹاک').fill('5');
    await expectNoSeriousAxe(page);
    await page
      .getByRole('button', { name: /^محفوظ کریں/ })
      .last()
      .click();
    await expect(
      page.getByRole('heading', { name: 'Charger 20W' }),
    ).toBeVisible();
    await expect(page.getByTestId('detail-on-hand')).toContainText('5 عدد');
    await expect(page.getByText('چارجر')).toBeVisible();
    await expectNoSeriousAxe(page);
    await page.goto('/bikri/products');
    await expect(page.getByText('1 مصنوع', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByLabel('زبان').selectOption('en');
  });

  test('AC 4: a cashier sees no cost, margin or profit, and no cost in the CSV', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await addCable(page);
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier', 'Sana'));
    await page.evaluate(() => window.__bikriTest?.navigate('/products'));
    await expect(
      page.getByRole('link', { name: /Type-C cable 1 m white/ }),
    ).toBeVisible();
    await expect(page.getByText('Avg cost')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Add product/ })).toHaveCount(
      0,
    );
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const text = Buffer.concat(
      await (await download.createReadStream()).toArray(),
    ).toString('utf8');
    expect(text).not.toContain('cost');
    expect(text).not.toContain('1100');
    await page.getByRole('link', { name: /Type-C cable 1 m white/ }).click();
    await expect(page.getByTestId('detail-price')).toContainText('Rs 1,499');
    await expect(page.getByTestId('detail-avg-cost')).toHaveCount(0);
    await expect(page.getByTestId('detail-margin')).toHaveCount(0);
    await expect(page.getByTestId('detail-profit')).toHaveCount(0);
    await expect(page.getByTestId('detail-stock-value')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Edit/ })).toHaveCount(0);
    await page.evaluate(() => window.__bikriTest?.navigate('/products/new'));
    await expect(page.getByText("You don't have access")).toBeVisible();
    await expect(page).toHaveURL(/\/bikri\/products$/);
  });

  test('categories: add, reorder, refuse delete while in use; works offline', async ({
    page,
    context,
  }) => {
    await openReadyShop(page, '/bikri/products/categories');
    await expect(page.getByText('No categories yet')).toBeVisible();
    await context.setOffline(true);
    for (const name of ['Chargers', 'Cables']) {
      await page.getByLabel('New category').fill(name);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByLabel(`Name of ${name}`)).toBeVisible();
    }
    await page.getByRole('button', { name: 'Move Cables up' }).click();
    await expect(page.getByLabel('Name of Cables')).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('input[aria-label^="Name of"]')
          .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
      )
      .toEqual(['Cables', 'Chargers']);
    await expectNoSeriousAxe(page);

    await page.evaluate(() => window.__bikriTest?.navigate('/products/new'));
    await page.getByLabel('Name (English)').fill('Fast charger');
    await page
      .getByLabel('Category', { exact: true })
      .selectOption({ label: 'Chargers' });
    await page.getByLabel('Sale price').fill('900');
    await page.keyboard.press('Control+s');
    await expect(
      page.getByRole('heading', { name: 'Fast charger' }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.__bikriTest?.navigate('/products/categories'),
    );
    await page.getByRole('button', { name: 'Delete Chargers' }).click();
    await expect(page.getByText('Move 1 product first')).toBeVisible();
    await page.getByRole('button', { name: 'Delete Cables' }).click();
    await expect(page.getByLabel('Name of Cables')).toHaveCount(0);
    await context.setOffline(false);
  });
});
