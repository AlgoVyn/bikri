import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { idbAll, openReadyShop } from './helpers.ts';

// T-050: remaining Settings sections, tax mode and Activity (screens/17 ACs 1–3, 8; journey 19).

async function navigate(page: Page, path: string) {
  await page.evaluate((to) => window.__bikriTest?.navigate(to), path);
}

test.describe('Settings (T-050)', () => {
  test('AC 1, 8: tax 17 + inclusive updates the preview, saves and appears in Activity', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/shop');
    await expect(
      page.getByRole('heading', { name: 'Shop profile & receipt' }),
    ).toBeVisible();
    await expect(page.getByLabel('Prices include tax')).toHaveCount(0);
    await page.getByLabel('Sales tax %').fill('17');
    await expect(page.getByLabel('Prices include tax')).toBeVisible();
    await page.getByLabel('Prices include tax').check();
    await expect(page.getByTestId('receipt-preview')).toContainText(
      'Sales tax 17%',
    );
    await expect(page.getByTestId('receipt-preview')).toContainText(
      'Includes Sales tax 17%',
    );
    await page
      .getByRole('button', { name: 'Save', exact: true })
      .first()
      .click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    const [shop] = await idbAll<{ tax_rate_bp: number; tax_mode: string }>(
      page,
      'shop',
    );
    expect(shop).toMatchObject({ tax_rate_bp: 1700, tax_mode: 'inclusive' });

    await page.goto('/bikri/settings/activity');
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'Shop settings' }),
    ).toBeVisible();
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const text = await readFile((await csv.path()) ?? '', 'utf8');
    expect(text).toContain('time,staff,device,action,entity,summary');
    expect(text).toContain('shop_change');

    await page.goto('/bikri/settings/about');
    await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
    await expect(page.getByText('Terms and privacy')).toBeVisible();
    await expect(
      page.getByText('No analytics, ads or tracking scripts.'),
    ).toBeVisible();
  });

  test('AC 3: the last owner cannot be deactivated, and a cashier can be added', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/cashiers');
    await page.getByRole('button', { name: /Adnan/ }).first().click();
    const ownerDialog = page.getByRole('dialog', { name: 'Edit cashier' });
    await expect(ownerDialog.getByText('Last owner')).toBeVisible();
    await expect(ownerDialog.getByLabel('Active')).toBeDisabled();
    await expect(ownerDialog.getByLabel('Role')).toBeDisabled();
    await ownerDialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Add cashier' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add cashier' });
    await dialog.getByLabel('Name').fill('Sana');
    await dialog.getByLabel('PIN (4–6 digits)').fill('2580');
    await dialog.getByLabel('Repeat PIN').fill('2580');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Sana/ })).toBeVisible();
    const staff = await idbAll<{ name: string; role: string; active: number }>(
      page,
      'staff',
    );
    expect(staff.find((row) => row.name === 'Sana')).toMatchObject({
      role: 'cashier',
      active: 1,
    });
  });

  test('AC 2 + journey 19: a cashier sees device settings only and cannot open owner pages by URL', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier'));
    await navigate(page, '/settings');
    await expect(page.getByRole('link', { name: /Printer/ })).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Scanner & display/ }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Language/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Sync/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /About/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Cashiers/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Activity/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Shop profile/ })).toHaveCount(
      0,
    );
    for (const path of [
      '/settings/shop',
      '/settings/cashiers',
      '/settings/activity',
    ]) {
      await navigate(page, path);
      await expect(page.getByTestId('settings-no-access')).toBeVisible();
    }
  });

  test('AC 7: the #printer link opens the Printer section directly', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings#printer');
    await expect(page).toHaveURL(/\/settings\/printer$/u);
    await expect(page.getByRole('heading', { name: 'Printer' })).toBeVisible();
  });

  test('device language, theme and text size apply immediately', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/display');
    await page.getByLabel('Theme').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByLabel('Text size').selectOption('130');
    await expect(page.locator('html')).toHaveCSS('font-size', '19.5px');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Display settings saved.')).toBeVisible();
    await page.getByRole('main').getByLabel('Language').selectOption('ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});
