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
    await expect(
      page.getByRole('heading', { name: 'Terms and privacy' }),
    ).toBeVisible();
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
    // Scope to the page: the top-bar printer pill is also a link to Printer.
    const settings = page.getByRole('main');
    await expect(settings.getByRole('link', { name: /Printer/ })).toBeVisible();
    await expect(
      settings.getByRole('link', { name: /Scanner & display/ }),
    ).toBeVisible();
    await expect(settings.getByRole('link', { name: /Language/ })).toHaveCount(
      0,
    );
    await expect(settings.getByRole('link', { name: /Sync/ })).toBeVisible();
    await expect(settings.getByRole('link', { name: /About/ })).toBeVisible();
    await expect(settings.getByRole('link', { name: /Cashiers/ })).toHaveCount(
      0,
    );
    await expect(settings.getByRole('link', { name: /Activity/ })).toHaveCount(
      0,
    );
    await expect(
      settings.getByRole('link', { name: /Shop profile/ }),
    ).toHaveCount(0);
    for (const path of [
      '/settings/shop',
      '/settings/cashiers',
      '/settings/activity',
    ]) {
      await navigate(page, path);
      await expect(page.getByTestId('settings-no-access')).toBeVisible();
    }
  });

  test('a manager cannot download the full shop copy with staff PIN verifiers', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await page.evaluate(() => window.__bikriTest?.unlockAs('manager'));
    await navigate(page, '/settings/backup');
    await expect(
      page.getByText('Only the owner can download a full shop copy.'),
    ).toBeVisible();
  });

  test('Devices has a visible import picker and a compact receipt preview', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings');
    await page.evaluate(() =>
      window.__bikriTest?.navigate('/settings/devices'),
    );
    const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
    await dialog
      .waitFor({ state: 'visible', timeout: 2_000 })
      .catch(() => undefined);
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
    }
    await expect(page.getByText('Choose file', { exact: true })).toBeVisible();
    await expect(page.getByText('No file chosen')).toBeVisible();

    await page.goto('/bikri/settings/shop');
    await expect(page.getByTestId('receipt-preview-card')).toBeVisible();
    const box = await page.getByTestId('receipt-preview-card').boundingBox();
    expect(box?.width ?? 0).toBeLessThan(400);
  });

  test('desktop Settings keeps the index beside the selected section', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop split view');
    await openReadyShop(page, '/bikri/settings');
    const settings = page.getByRole('main');
    await expect(settings.getByText('Choose a setting')).toBeVisible();
    await settings.getByRole('link', { name: /Printer/ }).click();
    await expect(
      settings.getByRole('heading', { name: 'Printer' }),
    ).toBeVisible();
    await expect(settings.getByText('Choose a setting')).toHaveCount(0);
    await expect(settings.getByRole('link', { name: /About/ })).toBeVisible();
  });

  test('every Settings section has a Back button to Settings', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/printer');
    await page.getByRole('link', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/u);

    await page.goto('/bikri/settings/sync');
    await expect(page.getByTestId('sync-page')).toBeVisible();
    await page.getByRole('link', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/u);

    for (const path of ['/settings/devices', '/settings/backup']) {
      await page.goto(`/bikri${path}`);
      const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
      await dialog
        .waitFor({ state: 'visible', timeout: 2_000 })
        .catch(() => undefined);
      if (await dialog.isVisible()) {
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toHaveCount(0);
      }
      await expect(
        page.getByRole('link', { name: 'Back', exact: true }),
      ).toHaveAttribute('href', '/bikri/settings');
    }
  });

  test('AC 7: the #printer link opens the Printer section directly', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings#printer');
    await expect(page).toHaveURL(/\/settings\/printer$/u);
    await expect(page.getByRole('heading', { name: 'Printer' })).toBeVisible();
  });

  test('About lists the keyboard shortcuts instead of button badges', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/about');
    await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Keyboard shortcuts' }),
    ).toBeVisible();
    await expect(page.getByText('Ctrl+Shift+P', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Ctrl+Shift+1…9', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Ctrl+Shift+9', { exact: true })).toHaveCount(
      0,
    );
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
