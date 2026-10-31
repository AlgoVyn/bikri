import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalScroll, idbAll, openReadyShop } from './helpers.ts';

// T-022: price check (screens/18 ACs 1–3).

async function shop(page: Page, path = '/bikri/') {
  await openReadyShop(page, path);
  await page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      {
        name: 'Type-C cable 1 m',
        name_ur: 'ٹائپ سی کیبل',
        price: 45000,
        cost: 30000,
        stock: 12,
        barcode: '8901111111111',
      },
      {
        name: 'Earbuds case',
        price: 90000,
        cost: 60000,
        stock: 0,
        barcode: '8903333333333',
      },
    ]),
  );
}

const dialog = (page: Page) =>
  page.getByRole('dialog', { name: /Price check|قیمت دیکھیں/u });
const field = (page: Page) => dialog(page).getByRole('searchbox');
const writes = async (page: Page) => ({
  outbox: (await idbAll(page, 'outbox')).length,
  audit: (await idbAll(page, 'audit_log')).length,
});

/** ms from the Enter keydown to the card in the DOM, measured in the page. */
async function timedScan(page: Page, code: string): Promise<number> {
  await field(page).fill(code);
  await page.evaluate(() => {
    const w = window as unknown as { __t0?: number; __t1?: number };
    w.__t0 = undefined;
    w.__t1 = undefined;
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') w.__t0 = performance.now();
      },
      { capture: true, once: true },
    );
    const obs = new MutationObserver(() => {
      if (document.querySelector('[data-testid="price-card"]')) {
        w.__t1 = performance.now();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
  await field(page).press('Enter');
  await expect(dialog(page).getByTestId('price-card')).toBeVisible();
  return page.evaluate(() => {
    const w = window as unknown as { __t0?: number; __t1?: number };
    return (w.__t1 ?? 0) - (w.__t0 ?? 0);
  });
}

test.describe('Price check (T-022)', () => {
  test('AC 1, 2: Home tile, scan shows the card fast, offline, nothing written; Enter adds to the cart', async ({
    page,
  }) => {
    await shop(page);
    await page.context().setOffline(true);
    await page
      .getByRole('main')
      .getByRole('button', { name: /^Price check/u })
      .click();
    await expect(field(page)).toBeFocused();
    const before = await writes(page);
    const ms = await timedScan(page, '8901111111111');
    expect(ms).toBeLessThan(100);
    const card = dialog(page).getByTestId('price-card');
    await expect(card).toContainText('Type-C cable 1 m');
    await expect(card).toContainText('ٹائپ سی کیبل');
    await expect(card.getByTestId('price-card-price')).toHaveText('Rs 450');
    await expect(card.getByTestId('price-card-stock')).toHaveText(
      '12 pc in stock',
    );
    await expect(card.getByTestId('price-card-cost')).toContainText('Rs 300');
    await expect(card.getByTestId('price-card-cost')).toContainText('33.3%');
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);

    // Scan another; out of stock; a name with several matches lists them.
    await dialog(page).getByRole('button', { name: 'Scan another' }).click();
    await expect(field(page)).toHaveValue('');
    await field(page).fill('8903333333333');
    await field(page).press('Enter');
    await expect(dialog(page).getByTestId('price-card-stock')).toHaveText(
      'Out of stock',
    );
    await field(page).fill('e');
    await field(page).press('Enter');
    await expect(
      dialog(page)
        .getByRole('list', { name: 'Matching products' })
        .getByRole('button'),
    ).toHaveCount(2);
    await dialog(page)
      .getByRole('button', { name: /Type-C cable/u })
      .click();
    await expect(dialog(page).getByTestId('price-card-price')).toHaveText(
      'Rs 450',
    );
    expect(await writes(page)).toEqual(before);
    await expectNoHorizontalScroll(page);

    // Enter on the shown product adds it to the active Sell cart.
    await field(page).press('Enter');
    await expect(dialog(page)).toHaveCount(0);
    await expect(
      page.getByText('Type-C cable 1 m added to the bill'),
    ).toBeVisible();
    await page.evaluate(() => window.__bikriTest?.navigate('/sell'));
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
    await expect(page.getByTestId('cart-line')).toContainText(
      'Type-C cable 1 m',
    );
  });

  test('Ctrl+Shift+P from a field; unknown barcode → Not found → Add product with the barcode', async ({
    page,
  }) => {
    await shop(page, '/bikri/sell');
    await page.locator('main input').first().focus();
    await page.keyboard.press('Control+Shift+KeyP');
    await expect(dialog(page)).toBeVisible();
    await field(page).fill('8909999999999');
    await field(page).press('Enter');
    await expect(dialog(page).getByText('Not found')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await page.keyboard.press('Control+Shift+KeyP');
    await field(page).fill('8909999999999');
    await field(page).press('Enter');
    await dialog(page).getByRole('link', { name: 'Add product' }).click();
    await expect(page).toHaveURL(/\/products\/new\?barcode=/u);
    await expect(page.getByLabel('Barcode 1')).toHaveValue('8909999999999');
  });

  test('AC 3: a cashier never sees cost', async ({ page }) => {
    await shop(page);
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier', 'Sana'));
    await page.keyboard.press('Control+Shift+KeyP');
    await field(page).fill('8901111111111');
    await field(page).press('Enter');
    await expect(dialog(page).getByTestId('price-card-price')).toHaveText(
      'Rs 450',
    );
    await expect(dialog(page).getByTestId('price-card-cost')).toHaveCount(0);
    await expect(dialog(page)).not.toContainText('Rs 300');
    await expect(dialog(page)).not.toContainText('Margin');
  });

  test('phone opens it from More; desktop from the rail', async ({
    page,
  }, info) => {
    await shop(page);
    if (info.project.name === 'phone') {
      await page.getByRole('button', { name: 'More' }).click();
      await page
        .locator('#more-menu')
        .getByRole('menuitem', { name: 'Price check' })
        .click();
    } else {
      await page
        .getByRole('navigation')
        .getByRole('button', { name: /Price check/u })
        .click();
    }
    await expect(field(page)).toBeFocused();
  });

  test('Urdu: name search in Urdu, labels in Urdu', async ({ page }) => {
    await shop(page);
    await page.getByLabel('Language').selectOption('ur');
    await page.keyboard.press('Control+Shift+KeyP');
    await expect(dialog(page)).toBeVisible();
    await field(page).fill('کیبل');
    await field(page).press('Enter');
    await expect(dialog(page).getByTestId('price-card-stock')).toContainText(
      'اسٹاک میں',
    );
    await expect(
      dialog(page).getByRole('button', { name: 'بل میں ڈالیں' }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
