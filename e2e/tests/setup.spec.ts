import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// T-012 setup wizard (screens/01), local mode (bikri-dev, D-088). ACs 1–7.

async function idbGet(
  page: Page,
  store: string,
  key: string,
): Promise<unknown> {
  return page.evaluate(
    ([s, k]) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('bikri-dev');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result
            .transaction(s, 'readonly')
            .objectStore(s)
            .get(k);
          req.onsuccess = () => {
            const value = req.result as Record<string, unknown> | undefined;
            open.result.close();
            resolve(
              value === undefined
                ? null
                : JSON.parse(
                    JSON.stringify(value, (_k, v) =>
                      v instanceof Uint8Array ? v.length : v,
                    ),
                  ),
            );
          };
          req.onerror = () => reject(req.error);
        };
      }),
    [store, key] as const,
  );
}

async function idbCount(page: Page, store: string): Promise<number> {
  return page.evaluate(
    (s) =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('bikri-dev');
        open.onsuccess = () => {
          const req = open.result
            .transaction(s, 'readonly')
            .objectStore(s)
            .count();
          req.onsuccess = () => {
            open.result.close();
            resolve(req.result);
          };
        };
      }),
    store,
  );
}

async function bigLogo(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 3000;
    c.height = 1000;
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    const g = ctx.createLinearGradient(0, 0, 3000, 0);
    g.addColorStop(0, '#000');
    g.addColorStop(1, '#fff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 3000, 1000);
    return c.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
}

async function typePin(page: Page, label: string, pin: string) {
  await page.getByLabel(`${label} digit 1`, { exact: true }).click();
  await page.keyboard.type(pin);
}

test.describe('setup wizard (T-012)', () => {
  test('English: validation, phone, PIN, tax, logo, skip lands on an empty Home', async ({
    page,
  }) => {
    await page.goto('/bikri/');
    await expect(page).toHaveURL(/\/bikri\/setup$/);
    await expect(
      page.getByRole('heading', { name: 'Welcome to Bikri' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Start' }).click();

    // AC2: all three required errors at once, focus on the first.
    await page.getByLabel('Shop name').fill('');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(
      page.getByText('Enter the shop name (2 to 60 letters).'),
    ).toBeVisible();
    await expect(
      page.getByText('Enter a valid Pakistan phone number.'),
    ).toBeVisible();
    await expect(
      page.getByText('Enter the address (5 to 120 letters).'),
    ).toBeVisible();
    await expect(page.getByLabel('Shop name')).toBeFocused();

    await page.getByLabel('Shop name').fill('Algovyn Mobiles');
    await page.getByRole('button', { name: 'Mobile shop' }).click();
    await page.getByLabel('Phone').fill('0300-1234567');
    await page.getByLabel('Address').fill('Shop 12, Hall Road, Lahore');
    await page.getByRole('button', { name: 'Next' }).click();

    // AC4: weak PIN and mismatch.
    await expect(page.getByRole('heading', { name: 'Owner' })).toBeVisible();
    await page.getByLabel('Your name').fill('Adnan');
    await typePin(page, 'PIN', '1234');
    await typePin(page, 'Confirm PIN', '1234');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Choose a less obvious PIN')).toBeVisible();
    for (let i = 1; i <= 4; i += 1)
      await page.getByLabel(`PIN digit ${i}`, { exact: true }).fill('');
    await typePin(page, 'PIN', '4826');
    await typePin(page, 'Confirm PIN', '4827');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText("PINs don't match")).toBeVisible();
    for (let i = 1; i <= 4; i += 1)
      await page.getByLabel(`Confirm PIN digit ${i}`).fill('');
    await typePin(page, 'Confirm PIN', '4826');
    await page.getByRole('button', { name: 'Next' }).click();

    // AC5 + AC6: tax 17 and a 3000 px logo.
    await expect(
      page.getByRole('heading', { name: 'Receipt and tax' }),
    ).toBeVisible();
    await expect(page.getByLabel('Prices include tax')).toHaveCount(0);
    await page.getByLabel('Sales tax %').fill('17');
    await expect(page.getByTestId('receipt-preview')).toContainText(
      'Sales tax 17%',
    );
    await expect(page.getByTestId('receipt-preview')).toContainText(
      'Powered by AlgoVyn',
    );
    await expect(page.getByLabel('Prices include tax')).toBeVisible();
    await page.getByTestId('logo-input').setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: await bigLogo(page),
    });
    const preview = page.getByAltText('Logo as the printer prints it');
    await expect(preview).toBeVisible();
    expect(
      await preview.evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBe(576);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      ),
    ).toEqual([]);
    await page.getByRole('button', { name: 'Next' }).click();

    // AC7: skip step 4.
    await expect(
      page.getByRole('heading', { name: 'First products' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page).toHaveURL(/\/bikri\/$/);
    await expect(
      page.getByRole('heading', { name: 'Your shop is ready' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Add your first products' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add product' })).toBeVisible();

    // AC3, AC5, AC6 in storage.
    const shop = (await idbGet(page, 'shop', 'shop')) as Record<
      string,
      unknown
    >;
    expect(shop).toMatchObject({
      name: 'Algovyn Mobiles',
      business_type: 'mobile',
      phone: '+923001234567',
      tax_rate_bp: 1700,
    });
    const bitmap = (await idbGet(page, 'kv', 'logo_bitmap')) as {
      value: { width: number };
    };
    expect(bitmap.value.width).toBeLessThanOrEqual(576);
    expect(await idbCount(page, 'products')).toBe(0);
    expect(await idbCount(page, 'file_queue')).toBe(1);

    // AC8 (local part): /setup now redirects to Home.
    await page.goto('/bikri/setup');
    await expect(page).toHaveURL(/\/bikri\/$/);
  });

  test('Urdu: language applies instantly with RTL, refresh keeps progress, first product is saved', async ({
    page,
  }) => {
    await page.goto('/bikri/setup');
    await page.getByRole('button', { name: 'اردو' }).click();
    // AC1
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { name: 'بکری میں خوش آمدید' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'شروع کریں' }).click();
    await page.getByLabel('دکان کا نام').fill('ہال روڈ الیکٹرانکس');
    await page.getByLabel('فون').fill('042 35761234');
    await page.getByLabel('پتہ').fill('دکان 4، ہال روڈ، لاہور');
    await page.getByRole('button', { name: 'آگے' }).click();
    await expect(page.getByRole('heading', { name: 'مالک' })).toBeVisible();

    // Refresh mid-wizard keeps progress (kv.setup_draft) but never the PIN.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'مالک' })).toBeVisible();
    await page.getByRole('button', { name: 'پیچھے' }).click();
    await expect(page.getByLabel('دکان کا نام')).toHaveValue(
      'ہال روڈ الیکٹرانکس',
    );
    await page.keyboard.press('Enter');
    await page.getByLabel('آپ کا نام').fill('بلال');
    await page.getByLabel('پن ہندسہ 1', { exact: true }).click();
    await page.keyboard.type('5937');
    await page.getByLabel('پن دوبارہ ہندسہ 1').click();
    await page.keyboard.type('5937');
    await page.getByRole('button', { name: 'آگے' }).click();
    await page.getByRole('button', { name: 'آگے' }).click();
    await page.getByRole('button', { name: 'ایک مصنوع شامل کریں' }).click();
    await page.getByLabel('مصنوع کا نام').fill('USB-C cable');
    await page.getByLabel('فروخت قیمت').fill('450');
    await page.getByLabel('ابتدائی اسٹاک').fill('10');
    await page.getByRole('button', { name: 'مکمل کریں' }).click();
    await expect(
      page.getByRole('heading', { name: 'آپ کی دکان تیار ہے' }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(await idbCount(page, 'products')).toBe(1);
    expect(await idbCount(page, 'stock_movements')).toBe(1);
    const shop = (await idbGet(page, 'shop', 'shop')) as Record<
      string,
      unknown
    >;
    expect(shop.phone).toBe('+924235761234');
  });
});
