import { expect, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  expectNoSeriousAxe,
  openReadyShop,
  setLanguage,
} from './helpers.ts';

async function openWithSales(page: import('@playwright/test').Page) {
  await openReadyShop(page, '/bikri/');
  await page.evaluate(() => window.__bikriTest?.seedTodaySales());
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test.describe('Privacy mode (screens/04)', () => {
  test('the Today eye hides only the Today card, persists, and leaves other screens readable', async ({
    page,
  }) => {
    await openWithSales(page);
    await expect(page.getByTestId('today-sold')).toContainText('Rs 1,000');

    await page.getByTestId('today-privacy-toggle').click();
    await expect(page.getByTestId('today-privacy-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('today-sold')).toContainText('Rs ••••');
    await expect(page.getByTestId('today-sold')).not.toContainText('1,000');
    await expect(page.getByTestId('today-udhaar-given')).toContainText(
      'Rs ••••',
    );
    await expect(page.getByTestId('today-udhaar-received')).toContainText(
      'Rs ••••',
    );
    await expectNoSeriousAxe(page);

    // The eye is local to the Today card: reports stay readable.
    await page.evaluate(() => window.__bikriTest?.navigate('/reports'));
    await expect(page.getByTestId('reports-page')).toBeVisible();
    await expect(page.getByTestId('report-sold')).toContainText('Rs 1,000');

    await page.evaluate(() => window.__bikriTest?.navigate('/'));
    await expect(page.getByTestId('today-sold')).toContainText('Rs ••••');
    await page.reload();
    await expect(page.getByTestId('today-privacy-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('today-sold')).toContainText('Rs ••••');

    // Showing again restores the Today amounts without touching other screens.
    await page.getByTestId('today-privacy-toggle').click();
    await expect(page.getByTestId('today-sold')).toContainText('Rs 1,000');
    await page.evaluate(() => window.__bikriTest?.navigate('/reports'));
    await expect(page.getByTestId('report-sold')).toContainText('Rs 1,000');
  });

  test('the device-wide hotkey and Settings switch still mask every browsing screen', async ({
    page,
  }) => {
    await openWithSales(page);
    await page.keyboard.press('Control+Shift+H');
    await expect(page.getByTestId('today-sold')).toContainText('Rs ••••');

    await page.evaluate(() => window.__bikriTest?.navigate('/reports'));
    await expect(page.getByTestId('report-sold')).toContainText('Rs ••••');
    await expect(page.getByTestId('report-sold')).not.toContainText('1,000');

    // A cashier must always see prices in the selling flow.
    await page.evaluate(() => window.__bikriTest?.navigate('/sell'));
    await expect(page.getByTestId('sell-tile').first()).toContainText('Rs 500');

    await page.keyboard.press('Control+Shift+H');
    await page.evaluate(() => window.__bikriTest?.navigate('/reports'));
    await expect(page.getByTestId('report-sold')).toContainText('Rs 1,000');
  });

  test('the Scanner & display switch controls the device-wide setting', async ({
    page,
  }) => {
    await openWithSales(page);
    await page.evaluate(() =>
      window.__bikriTest?.navigate('/settings/display'),
    );
    const setting = page.getByTestId('privacy-setting');
    await expect(setting).toBeVisible();
    await setting.check();
    await page.evaluate(() => window.__bikriTest?.navigate('/'));
    await expect(page.getByTestId('today-sold')).toContainText('Rs ••••');
    await page.evaluate(() =>
      window.__bikriTest?.navigate('/settings/display'),
    );
    await setting.uncheck();
    await page.evaluate(() => window.__bikriTest?.navigate('/'));
    await expect(page.getByTestId('today-sold')).toContainText('Rs 1,000');
  });

  test('Urdu masks Today amounts without raw values or overflow', async ({
    page,
  }) => {
    await openWithSales(page);
    await setLanguage(page, 'ur');
    await page.getByTestId('today-privacy-toggle').click();
    await expect(page.getByTestId('today-sold')).toContainText('••••');
    await expect(page.getByTestId('today-sold')).not.toContainText('1,000');
    await expectNoHorizontalScroll(page);
  });
});
