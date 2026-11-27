import { expect, type Page, test } from '@playwright/test';
import {
  clickPageAction,
  expectNoHorizontalScroll,
  expectNoSeriousAxe,
  idbUpdate,
  openReadyShop,
  setLanguage,
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
    // The history is a table on desktop and a card list on phones.
    await expect(
      page
        .getByText('Opening stock', { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    await expectNoSeriousAxe(page);
    await expectNoHorizontalScroll(page);

    // AC 7: Duplicate keeps details, clears SKU, barcodes and opening stock.
    await page
      .getByTestId('product-actions')
      .getByRole('button', { name: 'More actions' })
      .click();
    await page.getByRole('button', { name: 'Duplicate' }).click();
    const name = page.getByLabel('Name (English)');
    await expect(name).toHaveValue('Type-C cable 1 m white');
    await expect(name).toBeFocused();
    await expect(page.getByLabel('Brand')).toHaveValue('Anker');
    await expect(page.getByLabel('Sale price')).toHaveValue('1,499');
    await expect(page.getByLabel('Cost price')).toHaveValue('1,100');
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
      (async () => {
        await page.getByRole('button', { name: 'More actions' }).click();
        await page.getByRole('button', { name: 'Export CSV' }).click();
      })(),
    ]);
    const csv = await (await download.createReadStream()).toArray();
    const text = Buffer.concat(csv).toString('utf8');
    expect(text.split('\r\n')[0]).toContain('cost,avg_cost');
    expect(text).toContain('Type-C cable 1 m white');
    await expectNoSeriousAxe(page);
    await expectNoHorizontalScroll(page);
  });

  test('product notes show on the detail for every role and blank notes add no card', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/products');
    await addCable(page);
    await clickPageAction(page, 'Edit');
    await page
      .getByLabel('Notes')
      .fill('Wholesale rate changes weekly.\nBox includes the charger only.');
    await page.getByRole('button', { name: /^Save/ }).last().click();
    await expect(
      page.getByRole('heading', { name: 'Type-C cable 1 m white' }),
    ).toBeVisible();
    const notes = page.getByTestId('product-notes');
    await expect(notes).toBeVisible();
    await expect(notes).toContainText('Wholesale rate changes weekly.');
    await expect(notes).toContainText('Box includes the charger only.');

    // Staff-visible: a cashier keeps the note after the actions they cannot use disappear.
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier', 'Sana'));
    await page.evaluate(() => window.__bikriTest?.navigate('/products'));
    await page.getByRole('link', { name: /Type-C cable 1 m white/ }).click();
    await expect(page.getByTestId('product-notes')).toBeVisible();
    await expect(page.getByTestId('product-notes')).toContainText(
      'Wholesale rate changes weekly.',
    );

    // An empty note renders no empty card.
    const [plainId] = (await page.evaluate(
      () =>
        window.__bikriTest?.seedProducts([
          { name: 'Plain item', price: 10000 },
        ]) ?? [],
    )) as string[];
    await page.evaluate(
      (id) => window.__bikriTest?.navigate(`/products/${id}`),
      plainId,
    );
    await expect(
      page.getByRole('heading', { name: 'Plain item' }),
    ).toBeVisible();
    await expect(page.getByTestId('product-notes')).toHaveCount(0);
  });

  test('turning stock tracking off warns before saving and appears in history', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/products');
    await addCable(page);
    await clickPageAction(page, 'Edit');
    await page.getByRole('switch', { name: 'Track stock' }).click();
    await expect(page.getByText(/Stock tracking will stop\./u)).toBeVisible();

    // The save is blocked until the owner confirms the freeze.
    await page.getByRole('button', { name: /^Save/ }).last().click();
    await expect(
      page.getByRole('heading', {
        name: 'Stop tracking stock for Type-C cable 1 m white?',
      }),
    ).toBeVisible();
    await expect(page.getByText(/Current stock: 20 pc\./u)).toBeVisible();
    await page.getByRole('button', { name: 'Keep tracking' }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Stop tracking stock for Type-C cable 1 m white?',
      }),
    ).toBeHidden();
    await expect(
      page.getByRole('switch', { name: 'Track stock' }),
    ).toBeChecked();

    await page.getByRole('switch', { name: 'Track stock' }).click();
    await page.getByRole('button', { name: /^Save/ }).last().click();
    await page.getByRole('button', { name: 'Turn off tracking' }).click();
    await expect(
      page.getByRole('heading', { name: 'Type-C cable 1 m white' }),
    ).toBeVisible();
    await expect(page.getByTestId('detail-on-hand')).toHaveCount(0);
    await expect(
      page
        .getByText('Stock tracking turned off', { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId('history-change').filter({ visible: true }),
    ).toContainText('—');
    await expect(page.getByTestId('history-balance').first()).toHaveText('20');
    await expectNoSeriousAxe(page);
  });

  test('Urdu: RTL form and list', async ({ page }) => {
    await openReadyShop(page, '/bikri/products/new');
    await setLanguage(page, 'ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { name: 'مصنوع شامل کریں' }),
    ).toBeVisible();
    await page.getByLabel('نام (انگریزی)').fill('Charger 20W');
    await page.getByLabel('نام (اردو)').fill('چارجر');
    await page.getByLabel('فروخت کی قیمت').fill('1200');
    await page.getByLabel('ابتدائی اسٹاک').fill('5');
    await page.getByLabel('نوٹس').fill('گاہک کے لیے نوٹ');
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
    await expect(page.getByTestId('product-notes')).toContainText(
      'گاہک کے لیے نوٹ',
    );
    await expectNoSeriousAxe(page);

    // Turning tracking off warns in Urdu and can be cancelled before saving.
    await clickPageAction(page, 'تبدیل کریں');
    await page.getByRole('switch', { name: 'اسٹاک ٹریک کریں' }).click();
    await expect(page.getByText(/اسٹاک ٹریکنگ بند ہو جائے گی/u)).toBeVisible();
    await page
      .getByRole('button', { name: /^محفوظ کریں/ })
      .last()
      .click();
    await expect(
      page.getByRole('heading', {
        name: 'Charger 20W کے لیے اسٹاک ٹریکنگ بند کریں؟',
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'ٹریکنگ آن رکھیں' }).click();
    await expect(
      page.getByRole('switch', { name: 'اسٹاک ٹریک کریں' }),
    ).toBeChecked();
    await expectNoSeriousAxe(page);

    await page.goto('/bikri/products');
    await expect(page.getByText('1 مصنوع', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await setLanguage(page, 'en');
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
    // `export.data` is not a cashier permission; the whole actions menu is absent.
    await expect(
      page.getByRole('button', { name: 'More actions' }),
    ).toHaveCount(0);
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
    // Lazy route chunks come from the service-worker precache when offline.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
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
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete Chargers' })
      .click();
    await expect(page.getByText('Move 1 product first')).toBeVisible();
    await page.getByRole('button', { name: 'Delete Cables' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete Cables' })
      .click();
    await expect(page.getByLabel('Name of Cables')).toHaveCount(0);
    await context.setOffline(false);
  });

  test('the edit back button returns to the product and confirms unsaved edits', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/products');
    await addCable(page);
    await expect(page).toHaveURL(/\/products\/[^/]+$/u);
    const detailUrl = page.url();
    await clickPageAction(page, 'Edit');
    await expect(page).toHaveURL(/\/products\/[^/]+\/edit$/u);
    const editUrl = page.url();

    await page.getByLabel('Name (English)').fill('Changed before leaving');
    await page.getByRole('link', { name: 'Back to product' }).click();
    const discard = page.getByRole('dialog', { name: 'Discard changes?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(editUrl);
    await expect(page.getByLabel('Name (English)')).toHaveValue(
      'Changed before leaving',
    );

    await page.getByRole('link', { name: 'Back to product' }).click();
    await discard.getByRole('button', { name: 'Discard' }).click();
    await expect(page).toHaveURL(detailUrl);
    await expect(
      page.getByRole('heading', { name: 'Type-C cable 1 m white' }),
    ).toBeVisible();
  });

  test('the duplicate form back button returns to the source product', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/products');
    await addCable(page);
    const detailUrl = page.url();
    await page
      .getByTestId('product-actions')
      .getByRole('button', { name: 'More actions' })
      .click();
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(
      page.getByRole('heading', { name: 'Add product' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Back to product' }).click();
    await expect(page).toHaveURL(detailUrl);
  });

  test('1280 keeps the list full width until a product is selected', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop split view');
    await openReadyShop(page, '/bikri/products');
    await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Full width product', price: 100000, stock: 5 },
      ]),
    );
    await page.reload();
    await expect(page.getByTestId('products-master')).toBeVisible();
    const master = await page.getByTestId('products-master').boundingBox();
    expect(master?.width ?? 0).toBeGreaterThan(900);
    await expect(page.getByText('Select a product')).toHaveCount(0);
    await expect(page.getByText('Full width product')).toBeVisible();

    await page.getByRole('link', { name: /Full width product/ }).click();
    await expect(page.getByTestId('products-detail')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sell' })).toBeVisible();
    await page.getByRole('button', { name: 'Sell' }).click();
    await expect(page).toHaveURL(/\/bikri\/sell/);
    await expect(page.getByTestId('total-to-pay')).toContainText('Rs 1,000');
  });

  test('the shop Lakh setting changes the UI grouping and the receipt preview', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/products');
    const ids = await page.evaluate(
      () =>
        window.__bikriTest?.seedProducts([
          { name: 'Large amount', price: 123456789, stock: 1 },
        ]) ?? [],
    );
    const id = ids[0];
    if (!id) throw new Error('missing product');
    await idbUpdate(page, 'shop', 'shop', { number_grouping: 'lakh' });
    await page.reload();
    await expect(page.getByText('Rs 12,34,567.89').first()).toBeVisible();
  });

  test('the list header uses the shared style and aligns with row columns', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop columns');
    await openReadyShop(page, '/bikri/products');
    await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Header alignment', price: 100000, stock: 5 },
      ]),
    );
    const header = page.getByTestId('products-list-header');
    await expect(header).toBeVisible();
    await expect(header).toHaveClass(/bg-surface-2/);
    const headerName = await header
      .getByRole('button', { name: /Name/ })
      .boundingBox();
    const rowName = await page.locator('.ltr-name').first().boundingBox();
    expect(headerName).not.toBeNull();
    expect(rowName).not.toBeNull();
    expect(
      Math.abs((headerName as { x: number }).x - (rowName as { x: number }).x),
    ).toBeLessThan(1);
    const centers = await page.evaluate(() => {
      const header = document.querySelector(
        '[data-testid="products-list-header"]',
      );
      if (!header) return [];
      return [...header.children].slice(1).map((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        const box = range.getBoundingClientRect();
        return box.top + box.height / 2;
      });
    });
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
  });

  test('split view names the stock column instead of stacking it under price', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop columns');
    await openReadyShop(page, '/bikri/products');
    await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Stock column product', price: 100000, stock: 5 },
      ]),
    );
    await page.locator('main ul a').first().click();
    const header = page.getByTestId('products-list-header');
    await expect(header).toBeVisible();
    await expect(header.getByRole('button', { name: /^Price/ })).toBeVisible();
    await expect(header.getByRole('button', { name: /^Stock/ })).toBeVisible();
  });

  test('every column sorts in both directions', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop columns');
    await openReadyShop(page, '/bikri/products');
    await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Alpha', price: 30000, cost: 20000, stock: 3 },
        { name: 'Cheap', price: 10000, cost: 9000, stock: 1 },
        { name: 'Premium', price: 50000, cost: 40000, stock: 2 },
      ]),
    );
    const header = page.getByTestId('products-list-header');
    for (const column of [
      'Category',
      'Price',
      'Stock',
      'Avg cost',
      'Margin',
      'Sold',
    ]) {
      await expect(
        header.getByRole('button', { name: new RegExp(`^${column}`) }),
      ).toBeVisible();
    }
    const first = page.locator('.ltr-name').first();
    await expect(first).toHaveText('Alpha');
    const price = header.getByRole('button', { name: /^Price/ });
    await price.click();
    await expect(price).toHaveAttribute('data-sort-direction', 'asc');
    await expect(first).toHaveText('Cheap');
    await price.click();
    await expect(price).toHaveAttribute('data-sort-direction', 'desc');
    await expect(first).toHaveText('Premium');

    const direction = page.getByTestId('products-sort-direction');
    await expect(direction).toHaveAttribute('data-direction', 'desc');
    await direction.click();
    await expect(direction).toHaveAttribute('data-direction', 'asc');
    await expect(first).toHaveText('Cheap');

    const category = header.getByRole('button', { name: /^Category/ });
    await category.click();
    await expect(category).toHaveAttribute('data-sort-direction', 'asc');
  });
});
