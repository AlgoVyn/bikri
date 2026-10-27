import { expect, test } from '@playwright/test';
import { readBarcodes } from 'zxing-wasm/reader';
import { idbAll, idbUpdate, openReadyShop } from './helpers.ts';

// T-052: barcode labels (screens/20 ACs 1, 2, 4, 5; journey 18).

test.describe('Barcode labels (T-052)', () => {
  test('product list Select opens the same label dialog', async ({ page }) => {
    await openReadyShop(page, '/bikri/');
    await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Cable', price: 50000, stock: 3 },
      ]),
    );
    await page.goto('/bikri/products');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: /Cable/ }).first().click();
    await page.getByRole('button', { name: 'Print 1 label' }).click();
    const dialog = page.getByRole('dialog', { name: 'Print labels' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Cable', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Settings prints a test label', async ({ page }) => {
    await openReadyShop(page, '/bikri/');
    await page.goto('/bikri/settings/labels');
    const button = page.getByRole('button', { name: 'Print test label' });
    await expect(button).toBeEnabled();
    await button.click();
    await expect
      .poll(async () => {
        for (const frame of page.frames()) {
          if ((await frame.locator('.label').count()) === 1) return true;
        }
        return false;
      })
      .toBe(true);
    let labelFrame = page.mainFrame();
    for (const candidate of page.frames()) {
      if ((await candidate.locator('.label').count()) === 1) {
        labelFrame = candidate;
        break;
      }
    }
    expect(await labelFrame.locator('.label .name').textContent()).toContain(
      'Print test label',
    );
  });

  test('A4 start position and the Urdu product name', async ({ page }) => {
    await openReadyShop(page, '/bikri/');
    const [productId] =
      (await page.evaluate(() =>
        window.__bikriTest?.seedProducts([
          { name: 'Cable', name_ur: 'کیبل', price: 50000, stock: 3 },
        ]),
      )) ?? [];
    if (!productId) throw new Error('missing product');
    await idbUpdate(page, 'shop', 'shop', { receipt_language: 'ur' });
    await page.evaluate(() =>
      window.__bikriTest?.setKv('label', {
        size: 'a4',
        showShop: false,
        showPrice: true,
        dpi: 203,
        start: 2,
      }),
    );
    await page.goto(`/bikri/products/${productId}`);
    await page.getByRole('button', { name: /Print label/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Print labels' });
    await dialog.getByRole('button', { name: 'Generate barcode' }).click();
    await dialog.getByRole('button', { name: /Print 1 label/ }).click();
    await expect
      .poll(async () => {
        for (const frame of page.frames()) {
          if ((await frame.locator('.label').count()) === 1) return true;
        }
        return false;
      })
      .toBe(true);
    let labelFrame = page.mainFrame();
    for (const candidate of page.frames()) {
      if ((await candidate.locator('.label').count()) === 1) {
        labelFrame = candidate;
        break;
      }
    }
    expect(
      await labelFrame.locator('.label').first().locator('.name').textContent(),
    ).toContain('کیبل');
    expect(await labelFrame.locator('style').textContent()).toContain(
      'size: A4',
    );
    expect(await labelFrame.locator('.sheet > div').count()).toBe(3);
  });

  test('AC 1, 2, 4, 5: generate, decode, print 3 and scan', async ({
    page,
    context,
  }) => {
    await openReadyShop(page, '/bikri/');
    const [productId] =
      (await page.evaluate(() =>
        window.__bikriTest?.seedProducts([
          { name: 'Cable', price: 50000, stock: 3 },
        ]),
      )) ?? [];
    if (!productId) throw new Error('missing product');
    await page.goto(`/bikri/products/${productId}`);
    await page.getByRole('button', { name: /Print label/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Print labels' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Generate barcode' }).click();
    const barcodes = await idbAll<{ barcode: string }>(
      page,
      'product_barcodes',
    );
    const code = barcodes[0]?.barcode ?? '';
    expect(code).toMatch(/^2\d{11}$/u);
    await expect(dialog.getByText(code, { exact: true })).toBeVisible();

    const preview = dialog.getByTestId('label-preview');
    await expect(preview.locator('svg')).toBeVisible();
    const svgMarkup = await preview
      .locator('svg')
      .evaluate((el) => el.outerHTML);
    const dataUrl = await page.evaluate(async (svg) => {
      const url = URL.createObjectURL(
        new Blob([svg], { type: 'image/svg+xml' }),
      );
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('svg image failed'));
        image.src = url;
      });
      const scale = 4;
      const canvas = document.createElement('canvas');
      canvas.width = image.width * scale;
      canvas.height = image.height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas missing');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      return canvas.toDataURL('image/png').split(',')[1] ?? '';
    }, svgMarkup);
    const png = Buffer.from(dataUrl, 'base64');
    const decoded = await readBarcodes(new Blob([new Uint8Array(png)]), {
      formats: ['Code128'],
      tryHarder: true,
    });
    expect(decoded.some((result) => result.text === code)).toBe(true);

    await dialog.getByLabel('Copies Cable').fill('3');
    await dialog.getByRole('button', { name: /Print 3 labels/ }).click();
    await expect
      .poll(async () => {
        for (const frame of page.frames()) {
          if ((await frame.locator('.label').count()) === 3) return true;
        }
        return false;
      })
      .toBe(true);
    let labelFrame = page.mainFrame();
    for (const candidate of page.frames()) {
      if ((await candidate.locator('.label').count()) === 3) {
        labelFrame = candidate;
        break;
      }
    }
    expect(
      await labelFrame.locator('.label').first().locator('.name').textContent(),
    ).toContain('Cable');
    expect(await labelFrame.locator('style').textContent()).toContain(
      'size: 50mm 25mm',
    );
    const pdfPage = await context.newPage();
    await pdfPage.setContent(await labelFrame.content());
    const pdf = await pdfPage.pdf({
      preferCSSPageSize: true,
      printBackground: true,
    });
    await pdfPage.close();
    expect(
      (pdf.toString('latin1').match(/\/Type\s*\/Page\b/gu) ?? []).length,
    ).toBe(3);
    const barWidths = await labelFrame
      .locator('.bars svg rect')
      .evaluateAll((rects) =>
        rects.map((rect) => Number(rect.getAttribute('width'))),
      );
    expect(Math.min(...barWidths)).toBeCloseTo(0.375, 3);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.goto('/bikri/sell');
    await page.locator('#sell-search').focus();
    await page.keyboard.type(code, { delay: 0 });
    await page.keyboard.press('Enter');
    if ((page.viewportSize()?.width ?? 0) < 1024)
      await page.getByTestId('cart-bar').click();
    await expect(
      page.getByTestId('cart-line').filter({ hasText: 'Cable' }),
    ).toBeVisible();
  });
});
