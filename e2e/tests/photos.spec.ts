import { expect, test } from '@playwright/test';
import { idbCount, makePng, openReadyShop } from './helpers.ts';

// T-015: product photos — square 512 px WebP, stored on the device, queued for upload, shown offline.

test.describe('Product photos (T-015)', () => {
  test('a photo taken while offline shows on the product immediately and after an offline reload', async ({
    page,
    context,
  }) => {
    await openReadyShop(page, '/bikri/products');
    await page.evaluate(
      async () => (await navigator.serviceWorker.ready).active?.state,
    );
    await page.reload(); // controlled by the service worker from here
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    const png = await makePng(page, 1200, 800);
    await context.setOffline(true);

    await page.evaluate(() => window.__bikriTest?.navigate('/products/new'));
    await page.getByLabel('Name (English)').fill('Earbuds Pro');
    await page.getByLabel('Sale price').fill('2500');
    await page
      .getByText('Take or choose photo')
      .locator('input[type=file]')
      .setInputFiles({
        name: 'earbuds.png',
        mimeType: 'image/png',
        buffer: png,
      });
    const preview = page.getByTestId('form-photo');
    await expect(preview).toBeVisible();
    await page.keyboard.press('Control+s');
    await expect(
      page.getByRole('heading', { name: 'Earbuds Pro' }),
    ).toBeVisible();

    const photo = page
      .getByTestId('products-detail')
      .getByTestId('product-photo');
    await expect(photo).toBeVisible();
    const size = await photo.evaluate((img) => [
      (img as HTMLImageElement).naturalWidth,
      (img as HTMLImageElement).naturalHeight,
    ]);
    expect(size).toEqual([512, 512]);
    expect(await idbCount(page, 'file_queue')).toBe(1);
    const queued = await page.evaluate(
      () =>
        new Promise<{ type: string; size: number; key: string }>((resolve) => {
          const open = indexedDB.open('bikri-dev');
          open.onsuccess = () => {
            const tx = open.result.transaction(
              ['file_queue', 'products'],
              'readonly',
            );
            tx.objectStore('file_queue').getAll().onsuccess = (e) => {
              const [entry] = (e.target as IDBRequest).result as {
                blob: Blob;
                target_id: string;
              }[];
              if (!entry) return;
              tx.objectStore('products').get(entry.target_id).onsuccess = (
                p,
              ) => {
                const product = (p.target as IDBRequest).result as {
                  image_key: string;
                };
                resolve({
                  type: entry.blob.type,
                  size: entry.blob.size,
                  key: product.image_key,
                });
                open.result.close();
              };
            };
          };
        }),
    );
    expect(queued.type).toBe('image/webp');
    expect(queued.size).toBeLessThanOrEqual(150 * 1024);
    expect(queued.key).toMatch(/^products\/[0-9A-Z]{26}\/[0-9a-f]{64}\.webp$/u);

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Earbuds Pro' }),
    ).toBeVisible();
    await expect(
      page.getByTestId('products-detail').getByTestId('product-photo'),
    ).toBeVisible();
    await page.evaluate(() => window.__bikriTest?.navigate('/products'));
    await expect(
      page
        .getByRole('link', { name: /Earbuds Pro/ })
        .getByTestId('product-photo'),
    ).toBeVisible();
    await context.setOffline(false);
  });

  test('Urdu: replace and remove a photo on edit', async ({ page }) => {
    await openReadyShop(page, '/bikri/products/new');
    const png = await makePng(page, 600, 900);
    await page.getByLabel('Language').selectOption('ur');
    await page.getByLabel('نام (انگریزی)').fill('Cover');
    await page.getByLabel('فروخت کی قیمت').fill('300');
    await page
      .getByText('تصویر لیں یا چنیں')
      .locator('input[type=file]')
      .setInputFiles({
        name: 'c.png',
        mimeType: 'image/png',
        buffer: png,
      });
    await expect(page.getByTestId('form-photo')).toBeVisible();
    await page
      .getByRole('button', { name: /^محفوظ کریں/ })
      .last()
      .click();
    await expect(
      page.getByTestId('products-detail').getByTestId('product-photo'),
    ).toBeVisible();
    await page.getByRole('link', { name: /تبدیل کریں/ }).click();
    await expect(page.getByTestId('form-photo')).toBeVisible();
    await page.getByRole('button', { name: 'تصویر ہٹائیں' }).click();
    await expect(page.getByTestId('form-photo')).toHaveCount(0);
    await page
      .getByRole('button', { name: /^محفوظ کریں/ })
      .last()
      .click();
    await expect(page.getByRole('heading', { name: 'Cover' })).toBeVisible();
    await expect(
      page.getByTestId('products-detail').getByTestId('product-photo'),
    ).toHaveCount(0);
    await page.getByLabel('زبان').selectOption('en');
  });
});
