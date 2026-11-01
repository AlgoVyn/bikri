import { expect, test } from '@playwright/test';
import { openReadyShop } from './helpers.ts';

// Deterministic visual snapshots: fixed seed and SKUs, reduced motion, dynamic dates/times masked.
// A fixed diff budget absorbs text rasterisation noise without hiding a button-sized change.
// Run with --update-snapshots after an intentional design change.

const WIDTHS = [
  { width: 1280, height: 800, name: 'desktop' },
  { width: 390, height: 844, name: 'phone' },
] as const;

async function seedVisualShop(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('bikri.onboarding_dismissed', '1');
    localStorage.setItem('bikri.language', 'en');
    localStorage.setItem('bikri.theme', 'light');
  });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await openReadyShop(page, '/bikri/');
  await page.evaluate(async () => {
    const hooks = window.__bikriTest;
    if (!hooks) throw new Error('test hooks missing');
    await hooks.seedProducts([
      {
        name: 'Samsung Galaxy A15 128 GB',
        sku: 'SAM-A15',
        price: 5299000,
        cost: 4880000,
        stock: 6,
      },
      {
        name: 'Infinix Hot 40',
        sku: 'INF-H40',
        price: 3199000,
        cost: 2950000,
        stock: 11,
      },
      {
        name: 'Type-C fast charger 25W',
        sku: 'CHG-25W',
        price: 129900,
        cost: 88000,
        stock: 34,
      },
      {
        name: 'Tempered glass',
        sku: 'GLS-TMP',
        price: 24900,
        cost: 9000,
        stock: 2,
      },
      {
        name: 'Wireless earbuds',
        sku: 'EAR-WLS',
        price: 349900,
        cost: 260000,
        stock: 8,
      },
      {
        name: 'Power bank 10000 mAh',
        sku: 'PWB-10K',
        price: 449900,
        cost: 350000,
        stock: 4,
      },
      {
        name: 'USB-C cable 1 m',
        sku: 'CBL-USC',
        price: 49900,
        cost: 22000,
        stock: 60,
      },
      {
        name: 'Bluetooth speaker',
        sku: 'SPK-BT',
        price: 289900,
        cost: 210000,
        stock: 0,
      },
      {
        name: 'Phone cover',
        sku: 'CVR-PHN',
        price: 39900,
        cost: 15000,
        stock: 25,
      },
      {
        name: 'Car mount',
        sku: 'MNT-CAR',
        price: 89900,
        cost: 52000,
        stock: 9,
      },
    ]);
    await hooks.seedTodaySales();
    await hooks.seedCustomer({
      name: 'Bilal Ahmed',
      phone: '+923001112233',
      balance: 1250000,
      limit: 5000000,
    });
    await hooks.seedSupplier({
      name: 'Hall Road Mobiles',
      phone: '+924235761234',
      opening: 8500000,
    });
  });
  await page.reload();
  await page.waitForSelector('nav[aria-label="Main"]');
  await page.evaluate(() => document.fonts.ready);
}

test.describe('deterministic visual snapshots', () => {
  test.beforeEach(({ page }, testInfo) => {
    if (testInfo.project.name !== 'desktop') test.skip();
    void page;
  });

  for (const viewport of WIDTHS) {
    test(`core screens at ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await seedVisualShop(page);
      const shot = async (
        name: string,
        mask: import('@playwright/test').Locator[] = [],
      ) => {
        await expect(page).toHaveScreenshot(`${name}-${viewport.name}.png`, {
          animations: 'disabled',
          caret: 'hide',
          mask,
          maxDiffPixels: 1500,
        });
      };

      await page.evaluate(() => window.__bikriTest?.navigate('/'));
      await page.waitForTimeout(400);
      await shot('home', [
        page.locator('main header p').first(),
        page.getByText(/Last bill/),
        page.locator('section[aria-labelledby="recent-heading"] bdi'),
      ]);

      await page.evaluate(() => window.__bikriTest?.navigate('/sell'));
      await page.waitForTimeout(500);
      await shot('sell');

      await page.locator('[data-testid="sell-tile"]').first().click();
      if (viewport.width === 390) {
        await page.getByRole('button', { name: /View cart/ }).click();
      }
      await page.getByRole('button', { name: 'Take payment' }).click();
      await page.waitForTimeout(250);
      await shot('pay');
      await page.keyboard.press('Escape');

      await page.evaluate(() => window.__bikriTest?.navigate('/products'));
      await page.waitForTimeout(500);
      await shot('products');

      await page.evaluate(() => window.__bikriTest?.navigate('/reports'));
      await page.waitForTimeout(700);
      await shot('reports', [
        page.getByTestId('report-range'),
        page.getByTestId('report-chart'),
      ]);

      // The operator console shares the shell language; these two pages are stable
      // (no tenant rows or backup dates) so they can be snapshotted.
      await page.goto('/bikri/admin/tenants/new');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      await shot('admin-new');

      await page.goto('/bikri/admin/backups');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700);
      await shot('admin-backups');
    });
  }
});
