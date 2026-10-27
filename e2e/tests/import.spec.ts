import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalScroll, idbAll, openReadyShop } from './helpers.ts';

// T-023: import spreadsheet + update prices (screens/08 ACs 5, 6).

const HEAD =
  'name_en,name_ur,category,brand,barcode,sku,price,cost,stock,unit,min_stock,track_stock';
const XLSX = fileURLToPath(
  new URL('../fixtures/products.xlsx', import.meta.url),
);

const csvFile = (lines: string[]) => ({
  name: 'products.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(lines.join('\n')),
});

async function chooseFile(
  page: Page,
  file: Parameters<Page['setInputFiles']>[1],
) {
  await page.getByLabel('Choose a file').setInputFiles(file);
}

async function downloadText(page: Page, click: () => Promise<void>) {
  const wait = page.waitForEvent('download');
  await click();
  const dl = await wait;
  return {
    name: dl.suggestedFilename(),
    text: await readFile(String(await dl.path()), 'utf8'),
  };
}

type Row = { name_en: string; price: number; reason_code?: string };

test.describe('Import spreadsheet (T-023)', () => {
  test('template download; AC 5: 1,000 template rows import offline in < 10 s with 1,000 opening movements', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openReadyShop(page, '/bikri/products');
    await page.getByRole('link', { name: 'Import', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Import spreadsheet' }),
    ).toBeVisible();
    const template = await downloadText(page, () =>
      page.getByRole('button', { name: 'Download template' }).click(),
    );
    expect(template.name).toBe('bikri-products-template.csv');
    expect(template.text.replace(/^\uFEFF/u, '').split('\r\n')[0]).toBe(HEAD);

    const lines = [HEAD];
    for (let i = 0; i < 1000; i += 1) {
      lines.push(
        `Item ${i},,Cables,,89${String(i).padStart(11, '0')},,${100 + i},80,${(i % 9) + 1},pc,,yes`,
      );
    }
    await chooseFile(page, csvFile(lines));
    await expect(page.getByText('products.csv: 1000 rows')).toBeVisible();
    await expect(page.getByLabel('Price', { exact: true })).toHaveValue('6');
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);
    await page.getByRole('button', { name: 'Check rows' }).click();
    await expect(page.getByTestId('import-summary')).toHaveText(
      '1000 new, 0 updates (matched by SKU or barcode), 0 errors',
    );
    await expect(page.getByTestId('import-row')).toHaveCount(200);
    await expectNoHorizontalScroll(page);
    await page.context().setOffline(true);
    const started = Date.now();
    await page.getByRole('button', { name: 'Import 1000 rows' }).click();
    await expect(page.getByTestId('import-result')).toHaveText(
      'Imported: 1000 new, 0 updated, 0 skipped',
      {
        timeout: 10_000,
      },
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    const moves = await idbAll<{ reason_code: string }>(
      page,
      'stock_movements',
    );
    expect(moves.filter((m) => m.reason_code === 'opening')).toHaveLength(1000);
    expect(await idbAll(page, 'products')).toHaveLength(1000);
  });

  test('updates by barcode, row errors skipped and downloadable, stock/cost ignored note', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/products/import');
    await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        {
          name: 'Charger',
          price: 150000,
          cost: 100000,
          stock: 5,
          barcode: '8902222222222',
        },
      ]),
    );
    await chooseFile(
      page,
      csvFile([
        HEAD,
        'Fast charger,,,,8902222222222,,1600,999,50,,,',
        'No price,,,,,,,,,,,',
        'Cable,,,,8902222222222;8907777777777,CAB-9,450,,,,,',
        'Earbuds,,,,8908888888888,,1250.50,900,3,pc,,',
      ]),
    );
    await page.getByRole('button', { name: 'Check rows' }).click();
    await expect(page.getByTestId('import-summary')).toHaveText(
      '1 new, 1 updates (matched by SKU or barcode), 2 errors',
    );
    await expect(
      page.getByText('Stock and cost are not changed for matched products'),
    ).toBeVisible();
    await expect(page.getByTestId('import-row').nth(1)).toContainText(
      'Price is missing',
    );
    await expect(page.getByTestId('import-row').nth(2)).toContainText(
      'Barcode already used by Charger',
    );
    const errors = await downloadText(page, () =>
      page
        .getByRole('button', { name: 'Download errors (import-errors.csv)' })
        .click(),
    );
    expect(errors.name).toBe('import-errors.csv');
    expect(errors.text).toContain('3,No price');
    expect(errors.text).toContain('Barcode already used by Charger');
    await page.getByRole('button', { name: 'Import 2 rows' }).click();
    await expect(page.getByTestId('import-result')).toHaveText(
      'Imported: 1 new, 1 updated, 2 skipped',
    );
    const products = await idbAll<Row>(page, 'products');
    expect(products.map((p) => [p.name_en, p.price]).sort()).toEqual([
      ['Earbuds', 125050],
      ['Fast charger', 160000],
    ]);
    const levels = await idbAll<{ on_hand_milli: number }>(
      page,
      'stock_levels',
    );
    expect(levels.map((l) => l.on_hand_milli).sort()).toEqual([3000, 5000]);
  });

  test('XLSX with Roman Urdu headers auto-matches', async ({ page }) => {
    await openReadyShop(page, '/bikri/products/import');
    await chooseFile(page, XLSX);
    await expect(page.getByText('products.xlsx: 2 rows')).toBeVisible();
    await page.getByRole('button', { name: 'Check rows' }).click();
    await expect(page.getByTestId('import-summary')).toHaveText(
      '2 new, 0 updates (matched by SKU or barcode), 0 errors',
    );
    await page.getByRole('button', { name: 'Import 2 rows' }).click();
    await expect(page.getByTestId('import-result')).toContainText('2 new');
    const products = await idbAll<Row>(page, 'products');
    expect(products.map((p) => [p.name_en, p.price]).sort()).toEqual([
      ['Earbuds', 125000],
      ['Power bank', 320050],
    ]);
  });

  test('Home empty state opens the import; a cashier has no Import and the route goes back', async ({
    page,
  }) => {
    await openReadyShop(page);
    await page.getByRole('link', { name: 'Import spreadsheet' }).click();
    await expect(page).toHaveURL(/\/products\/import$/u);
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier', 'Sana'));
    await page.evaluate(() => window.__bikriTest?.navigate('/products'));
    await expect(
      page.getByRole('heading', { name: 'Products', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Import', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Update prices' })).toHaveCount(
      0,
    );
    for (const to of ['/products/import', '/products/prices']) {
      await page.evaluate((p) => window.__bikriTest?.navigate(p), to);
      await expect(page).toHaveURL(/\/products$/u);
    }
  });

  test('Urdu: import page and errors in Urdu', async ({ page }) => {
    await openReadyShop(page, '/bikri/products/import');
    await page.getByLabel('Language').selectOption('ur');
    await expect(
      page.getByRole('heading', { name: 'اسپریڈشیٹ امپورٹ کریں' }),
    ).toBeVisible();
    await page
      .getByLabel('فائل چنیں')
      .setInputFiles(csvFile([HEAD, 'بغیر قیمت,,,,,,,,,,,']));
    await page.getByRole('button', { name: 'لائنیں جانچیں' }).click();
    await expect(page.getByTestId('import-row')).toContainText('قیمت نہیں ہے');
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Update prices (T-023)', () => {
  test('AC 6: +10% with Rs 10 rounding turns Rs 1,499 into Rs 1,650', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/products');
    const [id] = (await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Headphones', price: 149900 },
        { name: 'Cover', price: 50000 },
      ]),
    )) as string[];
    await page.getByRole('link', { name: 'Update prices' }).click();
    await page.getByLabel('Percent (e.g. 10 or -5)').fill('10');
    await page.getByLabel('Rounding').selectOption({ label: 'To Rs 10' });
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByTestId('prices-summary')).toHaveText(
      '2 of 2 products change',
    );
    const row = page.getByTestId('price-row').filter({ hasText: 'Headphones' });
    await expect(row).toContainText('Rs 1,499');
    await expect(row).toContainText('Rs 1,650');
    await expect(
      page.getByTestId('price-row').filter({ hasText: 'Cover' }),
    ).toContainText('Rs 550');
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Apply to 2 products' }).click();
    await expect(page.getByText('Prices updated for 2 products')).toBeVisible();
    const audit = await idbAll<{ action: string; entity_id: string }>(
      page,
      'audit_log',
    );
    expect(audit.filter((a) => a.action === 'price_change')).toHaveLength(2);
    await page.evaluate(
      (p) => window.__bikriTest?.navigate(p),
      `/products/${id}`,
    );
    await expect(page.getByText('Rs 1,650').first()).toBeVisible();
  });

  test('Urdu: set to a price', async ({ page }) => {
    await openReadyShop(page, '/bikri/products/prices');
    await page.evaluate(() =>
      window.__bikriTest?.seedProducts([{ name: 'Cover', price: 50000 }]),
    );
    await page.getByLabel('Language').selectOption('ur');
    await page.getByRole('main').getByLabel('تبدیلی').selectOption('set');
    await page.getByLabel('روپے', { exact: true }).fill('600');
    await page.getByRole('button', { name: 'پیش نظارہ' }).click();
    await expect(page.getByTestId('price-row')).toContainText('Rs 600');
    await page.getByRole('button', { name: '1 پروڈکٹ پر لگائیں' }).click();
    const products = await idbAll<Row>(page, 'products');
    await expect
      .poll(async () => (await idbAll<Row>(page, 'products'))[0]?.price)
      .toBe(60000);
    expect(products).toHaveLength(1);
  });
});

test.describe('Import column mapper (manual run-through of M1)', () => {
  test('Roman Urdu headers auto-match', async ({ page }) => {
    await openReadyShop(page, '/bikri/products/import');
    await chooseFile(
      page,
      csvFile([
        'Naam,Qeemat (Rs),Laagat,Miqdar,Barcode',
        'Chai,250,200,10,8961000000011',
      ]),
    );
    await expect(page.getByText('products.csv: 1 rows')).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('0');
    await expect(page.getByLabel('Price', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('Cost', { exact: true })).toHaveValue('2');
    await expect(page.getByLabel('Stock', { exact: true })).toHaveValue('3');
    await expect(page.getByLabel('Barcode', { exact: true })).toHaveValue('4');
  });
});
