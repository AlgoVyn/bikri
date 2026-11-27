import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { idbAll, openReadyShop } from './helpers.ts';

// T-050: remaining Settings sections, tax mode and Activity (screens/17 ACs 1–3, 8; journey 19).

async function navigate(page: Page, path: string) {
  await page.evaluate((to) => window.__bikriTest?.navigate(to), path);
}

async function logoPng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 100;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 300, 100);
    return canvas.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
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
      page.getByRole('heading', { name: 'Terms of use' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible();
    await expect(
      page.getByText('No analytics, ads or tracking scripts.'),
    ).toBeVisible();
  });

  test('the shop section Save stores the logo, and its preview survives navigation', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/shop');
    await expect(page.getByRole('button', { name: 'Save logo' })).toHaveCount(
      0,
    );

    await page.getByTestId('logo-input').setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: await logoPng(page),
    });
    const logoPreview = page.getByTestId('logo-preview');
    await expect(logoPreview).toBeVisible();
    const receiptLogo = page
      .getByTestId('receipt-preview-card')
      .getByAltText('Logo as the printer prints it');
    await expect(receiptLogo).toBeVisible();
    expect(
      await receiptLogo.evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBe(576);
    // The logo must not widen the preview: the paper follows the receipt text and
    // the logo is centred over it.
    const cardBox = await page
      .getByTestId('receipt-preview-card')
      .boundingBox();
    const textBox = await page.getByTestId('receipt-preview').boundingBox();
    const logoBox = await receiptLogo.boundingBox();
    expect(cardBox?.width ?? 0).toBeLessThan(400);
    expect(logoBox?.width ?? 0).toBeLessThanOrEqual((textBox?.width ?? 0) + 1);
    expect(
      Math.abs(
        (logoBox?.x ?? 0) +
          (logoBox?.width ?? 0) / 2 -
          ((textBox?.x ?? 0) + (textBox?.width ?? 0) / 2),
      ),
    ).toBeLessThanOrEqual(1);
    // Choosing is not saving: the section Save button persists it with the shop fields.
    const beforeSave = await idbAll<{ key: string }>(page, 'kv');
    expect(beforeSave.some((row) => row.key === 'logo_bitmap')).toBe(false);

    await page
      .getByRole('button', { name: 'Save', exact: true })
      .first()
      .click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    const [shop] = await idbAll<{ logo_key: string | null }>(page, 'shop');
    expect(shop?.logo_key).toMatch(/^shop\/logo-[0-9a-f]{64}\.png$/u);
    const saved = await idbAll<{ key: string }>(page, 'kv');
    expect(saved.some((row) => row.key === 'logo_bitmap')).toBe(true);

    await page.goto('/bikri/settings/activity');
    await page.goto('/bikri/settings/shop');
    await expect(logoPreview).toBeVisible();
    await expect(receiptLogo).toBeVisible();
    expect(
      await receiptLogo.evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBe(576);

    // The logo stays uploaded but can be hidden from printed receipts.
    await page.getByLabel('Show logo on receipts').uncheck();
    await expect(receiptLogo).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Save', exact: true })
      .first()
      .click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await page.goto('/bikri/settings/activity');
    await page.goto('/bikri/settings/shop');
    await expect(page.getByLabel('Show logo on receipts')).not.toBeChecked();
    await expect(logoPreview).toBeVisible();
    await expect(receiptLogo).toHaveCount(0);
    await page.getByLabel('Show logo on receipts').check();

    // Removing the logo is also saved by the same section button.
    await page.getByRole('button', { name: 'Remove logo' }).click();
    await expect(logoPreview).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Save', exact: true })
      .first()
      .click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    const [cleared] = await idbAll<{ logo_key: string | null }>(page, 'shop');
    expect(cleared?.logo_key).toBeNull();
    await page.goto('/bikri/settings/activity');
    await page.goto('/bikri/settings/shop');
    await expect(logoPreview).toHaveCount(0);
    await expect(receiptLogo).toHaveCount(0);
  });

  test('the shop name is bold in the preview and can be hidden from receipts', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/shop');
    const preview = page.getByTestId('receipt-preview');
    const shopName = preview.getByText('ALGOVYN MOBILES', { exact: true });
    await expect(shopName).toBeVisible();
    await expect(shopName).toHaveCSS('font-weight', '700');

    await page.getByLabel('Show shop name on receipts').uncheck();
    await expect(shopName).toHaveCount(0);
    await expect(preview).toContainText('Hall Road');

    await page
      .getByRole('button', { name: 'Save', exact: true })
      .first()
      .click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await page.goto('/bikri/settings/shop');
    await expect(
      page.getByLabel('Show shop name on receipts'),
    ).not.toBeChecked();
    await expect(
      page.getByTestId('receipt-preview').getByText('ALGOVYN MOBILES', {
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test('AC 3: the last owner cannot be deactivated, and a cashier can be added', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/cashiers');
    // The staff-menu avatar is also named Adnan; the cashier row is in main.
    await page
      .locator('main')
      .getByRole('button', { name: /Adnan/ })
      .first()
      .click();
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
    await expect(
      settings.getByRole('link', { name: /Receipt printer/ }),
    ).toBeVisible();
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

  test('Devices hides the unsynced import before enrolment; receipt preview stays compact', async ({
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
    // The dev shop is not enrolled: importing ops needs a device token and is hidden
    // rather than offering a picker that cannot be used (UI-L7).
    await expect(
      page.getByRole('heading', { name: 'Import unsynced ops' }),
    ).toHaveCount(0);

    await page.goto('/bikri/settings/shop');
    await expect(page.getByTestId('receipt-preview-card')).toBeVisible();
    const box = await page.getByTestId('receipt-preview-card').boundingBox();
    expect(box?.width ?? 0).toBeLessThan(400);
  });

  test('Data safety is visible and settings can be searched', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings');
    const main = page.getByRole('main');
    await expect(main.getByText('Data safety')).toBeVisible();
    const search = main.getByLabel('Search settings');
    await search.fill('printer');
    await expect(
      main.getByRole('link', { name: /Receipt printer/ }),
    ).toBeVisible();
    await expect(main.getByRole('link', { name: /Cashiers/ })).toHaveCount(0);
    await search.fill('zzzz');
    await expect(main.getByText('No settings match.')).toBeVisible();
  });

  test('desktop Settings is a centred index and a row opens that section', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop layout');
    await openReadyShop(page, '/bikri/settings');
    const settings = page.getByRole('main');
    const index = settings.getByTestId('settings-index');
    await expect(index).toBeVisible();
    await expect(
      settings.getByRole('heading', { level: 1, name: 'Settings' }),
    ).toBeVisible();
    await expect(settings.getByText('Choose a setting')).toHaveCount(0);
    await expect(
      settings.getByRole('heading', { name: 'Shop profile & receipt' }),
    ).toHaveCount(0);
    await expect(settings.locator('a[aria-current="page"]')).toHaveCount(0);

    // The index is a normal centred page in the workspace, like Products and Sales.
    const indexBox = await index.boundingBox();
    const railBox = await page
      .getByRole('navigation', { name: 'Main' })
      .boundingBox();
    const viewport = page.viewportSize();
    expect(indexBox).not.toBeNull();
    const contentCenter =
      (railBox?.width ?? 0) +
      ((viewport?.width ?? 0) - (railBox?.width ?? 0)) / 2;
    expect(
      Math.abs(
        (indexBox as { x: number; width: number }).x +
          (indexBox as { width: number }).width / 2 -
          contentCenter,
      ),
    ).toBeLessThan(2);

    await settings
      .getByRole('link', { name: /Shop profile & receipt/ })
      .click();
    await expect(page).toHaveURL(/\/settings\/shop$/u);
    await expect(
      settings.getByRole('heading', {
        level: 1,
        name: 'Shop profile & receipt',
      }),
    ).toBeVisible();
    await expect(settings.getByTestId('settings-index')).toBeVisible();
    await expect(
      settings.getByTestId('settings-index').locator('a[aria-current="page"]'),
    ).toHaveAttribute('href', '/bikri/settings/shop');
    await expect(
      settings.getByRole('link', { name: 'Back', exact: true }),
    ).toHaveAttribute('href', '/bikri/settings');
  });

  test('Settings index has no selected section before choosing', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings');
    const settings = page.getByRole('main');
    await expect(settings.getByTestId('settings-index')).toBeVisible();
    await expect(settings.locator('a[aria-current="page"]')).toHaveCount(0);
    await expect(
      settings.getByRole('heading', { name: 'Shop profile & receipt' }),
    ).toHaveCount(0);
  });

  test('choosing a section opens it at the top of the page', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);

    await page.getByRole('link', { name: /About/ }).click();
    await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeLessThan(10);
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

  test('About shows version and terms without external source links', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/about');
    await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
    await expect(page.getByText(/^Version:/u)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Source code' })).toHaveCount(
      0,
    );
    await expect(page.getByRole('link', { name: 'Licence' })).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Terms of use' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Keyboard shortcuts' }),
    ).toHaveCount(0);
  });

  test('device language, theme and text size apply immediately', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/settings/display');
    await page
      .getByRole('group', { name: 'Theme' })
      .getByRole('button', { name: 'Dark' })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page
      .getByRole('group', { name: 'Text size' })
      .getByRole('button', { name: '130%' })
      .click();
    await expect(page.locator('html')).toHaveCSS('font-size', '19.5px');
    await page
      .getByRole('group', { name: 'Lock-screen keypad' })
      .getByRole('button', { name: /Computer/ })
      .click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Display settings saved.')).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole('group', { name: 'Lock-screen keypad' })
        .getByRole('button', { name: /Computer/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page
      .getByRole('main')
      .getByRole('group', { name: 'Language' })
      .getByRole('button', { name: 'اردو' })
      .click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('the shop card saves its own details', async ({ page }) => {
    await openReadyShop(page, '/bikri/settings/shop');
    await page.getByLabel('Shop name', { exact: true }).fill('Saved Shop');
    await page
      .getByRole('button', { name: 'Save', exact: true })
      .first()
      .click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    const [shop] = await idbAll<{ name: string }>(page, 'shop');
    expect(shop?.name).toBe('Saved Shop');
  });
});
