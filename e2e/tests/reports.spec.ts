import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  idbUpdate,
  openReadyShop,
} from './helpers.ts';

// T-048: Reports (screens/16 ACs 1–6).

async function seedReports(page: import('@playwright/test').Page) {
  await openReadyShop(page, '/bikri/');
  await page.evaluate(() => window.__bikriTest?.seedTodaySales());
  await page.evaluate(() => window.__bikriTest?.navigate('/reports'));
  await expect(page.getByTestId('reports-page')).toBeVisible();
}

test.describe('Reports (T-048)', () => {
  test('AC 1, 6: summary cards, tabs and the documented two-decimal CSV', async ({
    page,
  }) => {
    await seedReports(page);
    await expect(page.getByTestId('report-sold')).toContainText('Rs 1,000');
    await expect(page.getByTestId('report-bills')).toContainText('2');
    await expect(page.getByTestId('report-profit')).toContainText('Rs 400');
    await expect(page.getByTestId('report-expenses-total')).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    await page.getByRole('button', { name: 'Export' }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'CSV' }).click(),
    ]);
    const text = await readFile((await download.path()) ?? '', 'utf8');
    expect(text).toContain(
      'date,bills,sold,gross_profit,expenses,net_profit,udhaar_given,udhaar_received,tax_collected,cash,card,bank_wallet,udhaar',
    );
    expect(text).toContain('1000.00');
    expect(text).toContain('TOTAL');
    expect(text).not.toMatch(/,100000(,|\r)/);

    await page.getByRole('button', { name: 'Export' }).click();
    const [pdf] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'PDF' }).click(),
    ]);
    const pdfBytes = await readFile((await pdf.path()) ?? '');
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');

    await page.getByRole('tab', { name: 'Products' }).click();
    await expect(page.getByTestId('report-best-qty')).toContainText('Charger');
    await expectNoHorizontalScroll(page);
    await page.getByRole('tab', { name: 'Udhaar' }).click();
    await expect(page.getByTestId('report-udhaar-total')).toContainText(
      'Rs 200',
    );
    await expect(page.getByTestId('report-top-debtors')).toContainText('Bilal');
    await page.getByRole('tab', { name: 'Staff' }).click();
    await expect(page.getByTestId('report-staff')).toContainText('Adnan');
    await page.getByRole('tab', { name: 'Expenses' }).click();
    await expect(page.getByTestId('report-expenses')).toContainText(
      'Electricity',
    );
    await expect(page.getByTestId('report-expenses')).toContainText('Rs 50');
    await page.getByRole('tab', { name: 'Day closes' }).click();
    await expect(page.getByText('No day closes in this range.')).toBeVisible();
  });

  test('AC 5: stock value, low stock and slow movers', async ({ page }) => {
    await openReadyShop(page, '/bikri/');
    const ids = await page.evaluate(
      () =>
        window.__bikriTest?.seedProducts([
          { name: 'Cable', price: 50000, cost: 30000, stock: 5 },
        ]) ?? [],
    );
    const cableId = ids[0];
    if (!cableId) throw new Error('missing product');
    await idbUpdate(page, 'products', cableId, { min_stock_milli: 6000 });
    await page.evaluate(() => window.__bikriTest?.seedTodaySales());
    await page.evaluate(() => window.__bikriTest?.navigate('/reports'));
    await page.getByRole('tab', { name: 'Stock' }).click();
    await expect(page.getByTestId('report-stock-attention')).toContainText(
      'Cable',
    );
    await expect(page.getByText('Rs 1,500').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Products' }).click();
    await expect(page.getByTestId('report-slow-movers')).toContainText('Cable');
  });

  test('AC 4: a cashier sees only Today and no profit cards', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await page.evaluate(() => window.__bikriTest?.seedTodaySales());
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier'));
    await page.evaluate(() => window.__bikriTest?.navigate('/reports'));
    await expect(page.getByTestId('report-sold')).toContainText('Rs 1,000');
    await expect(page.getByTestId('report-profit')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Yesterday' })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Products' }).click();
    await expect(page.getByText('Gross profit')).toHaveCount(0);
  });

  test('Urdu reports', async ({ page }) => {
    await seedReports(page);
    await page.getByLabel('Language').selectOption('ur');
    await expect(page.getByRole('heading', { name: 'رپورٹس' })).toBeVisible();
    await expect(page.getByTestId('report-sold')).toContainText('فروخت');
    await expect(page.getByRole('tab', { name: 'مصنوعات' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'آج' })).toBeVisible();
  });
});
