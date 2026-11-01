import { expect, test } from '@playwright/test';
import { openReadyShop } from './helpers.ts';

test('a sale after the sample day uses the next invoice number', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop selling flow');
  await openReadyShop(page, '/bikri/');
  await page.evaluate(() => window.__bikriTest?.seedTodaySales());
  await page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Charger', price: 50000, sku: 'CHG-NEXT' },
    ]),
  );
  await page.reload();
  await page.waitForFunction(() => window.__bikriTest !== undefined);
  await page.evaluate(() => window.__bikriTest?.navigate('/sell'));
  await page.waitForTimeout(500);
  await page.locator('[data-testid="sell-tile"]').last().click();
  await page.getByRole('button', { name: 'Take payment' }).click();
  await page.getByTestId('pay-done').click();
  await expect(
    page.getByRole('dialog', { name: 'Sale complete' }),
  ).toBeVisible();
  await expect(
    page.getByText('The sale was not saved. Try again.'),
  ).toHaveCount(0);
  await expect(page.getByTestId('sale-saved')).toContainText('A-A-3');
});
