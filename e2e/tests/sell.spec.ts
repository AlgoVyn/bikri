import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalScroll, openReadyShop } from './helpers.ts';

// T-016: Sell screen (screens/05 ACs 1–9).

type Seed = Parameters<NonNullable<Window['__bikriTest']>['seedProducts']>[0];

async function openSell(page: Page, products: Seed = []): Promise<void> {
  await openReadyShop(page, '/bikri/sell');
  if (products.length > 0)
    await page.evaluate(
      (list) => window.__bikriTest?.seedProducts(list),
      products,
    );
  await expect(
    page.getByRole('combobox', { name: /Search or scan|تلاش یا اسکین/ }),
  ).toBeFocused();
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;

/** On phones the cart is a sheet behind the sticky cart bar. */
async function showCart(page: Page): Promise<void> {
  if (isPhone(page)) await page.getByTestId('cart-bar').click();
}

async function showProducts(page: Page): Promise<void> {
  if (isPhone(page))
    await page
      .getByRole('button', { name: /Back to products|پروڈکٹس پر واپس/ })
      .click();
}

async function scan(page: Page, code: string): Promise<void> {
  await page.locator('#sell-search').focus();
  await page.keyboard.type(code, { delay: 0 });
  await page.keyboard.press('Enter');
}

const tile = (page: Page, name: string) =>
  page.getByTestId('sell-tile').filter({ hasText: name });

test.describe('Sell (T-016)', () => {
  test('category chips show their names, never undefined', async ({ page }) => {
    await openReadyShop(page, '/bikri/products/categories');
    await page.getByPlaceholder('New category').fill('Cables');
    await page
      .locator('form')
      .getByRole('button', { name: 'Add', exact: true })
      .click();
    await page.goto('/bikri/sell');
    await expect(page.getByRole('button', { name: 'Cables' })).toBeVisible();
    await expect(page.getByText('undefined', { exact: true })).toHaveCount(0);
  });

  test('AC 1, 8: scanning one barcode 3 times is one line of 3 with 3 beeps; unknown barcode; quick sale', async ({
    page,
  }) => {
    await openSell(page, [
      {
        name: 'Type-C cable',
        price: 149900,
        cost: 110000,
        barcode: '8964000111222',
        stock: 20,
      },
    ]);
    await expect(tile(page, 'Type-C cable')).toContainText('20 left');
    const before = await page.evaluate(() => window.__bikriTest?.beeps() ?? 0);
    for (let i = 0; i < 3; i += 1) await scan(page, '8964000111222');
    await expect
      .poll(() => page.evaluate(() => window.__bikriTest?.beeps() ?? 0))
      .toBe(before + 3);
    await showCart(page);
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
    await expect(page.getByLabel('Quantity of Type-C cable')).toHaveValue('3');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 4,497');
    await showProducts(page);

    // Unknown barcode: toast with Add product and Quick sale.
    await scan(page, '8964999000111');
    const toast = page
      .getByRole('alert')
      .filter({ hasText: 'No product with barcode 8964999000111' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Quick sale' }).click();

    // AC 8: quick sale "Repair labour" Rs 500.
    const dialog = page.getByRole('dialog', { name: 'Quick sale' });
    await dialog.getByLabel('Description').fill('Repair labour');
    await dialog.getByLabel('Price').fill('500');
    await dialog.getByRole('button', { name: 'Add to cart' }).click();
    await showCart(page);
    await expect(page.getByTestId('line-name').first()).toHaveText(
      'Repair labour',
    );
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 4,997');
    await expect(page.getByTestId('cart-totals')).toContainText(
      'Subtotal (4 items)',
    );
    await expectNoHorizontalScroll(page);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);
  });

  test('AC 3, 7: vector T2 totals; selling more than stock shows the amber badge', async ({
    page,
  }) => {
    await openSell(page, [
      { name: 'Galaxy A15', price: 4200000, cost: 3800000, stock: 1 },
      { name: 'Earbuds', price: 350000, cost: 200000, stock: 5 },
    ]);
    await tile(page, 'Galaxy A15').click();
    await tile(page, 'Earbuds').click();
    await showCart(page);
    await page
      .getByTestId('cart-line')
      .getByRole('button', { name: /^Galaxy A15/ })
      .click();
    await page
      .getByTestId('cart-line')
      .filter({ hasText: 'Galaxy A15' })
      .getByLabel('Discount', { exact: true })
      .fill('2000');
    await page.keyboard.press('F3');
    const dialog = page.getByRole('dialog', { name: 'Bill discount' });
    await dialog.getByLabel('Discount', { exact: true }).fill('500');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByTestId('total-subtotal')).toHaveText('Rs 45,500');
    await expect(page.getByTestId('cart-totals')).toContainText(
      'Subtotal (2 items)',
    );
    await expect(page.getByTestId('total-item-discounts')).toHaveText(
      '−Rs 2,000',
    );
    await expect(page.getByTestId('total-discount')).toHaveText('−Rs 500');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 43,000');
    await expect(page.getByTestId('badge-discount')).toHaveText('−Rs 2,000');

    // AC 7 (badge part): 2 phones with 1 in stock.
    await page.getByLabel('Quantity of Galaxy A15').fill('2');
    await expect(page.getByTestId('badge-stock')).toHaveText('Only 1 in stock');
    await expect(
      page.getByRole('button', { name: /Take payment/ }),
    ).toBeEnabled();
  });

  test('AC 4: a cashier selling below cost needs the manager PIN before payment', async ({
    page,
  }) => {
    await openSell(page, [
      { name: 'Charger 20W', price: 90000, cost: 100000, stock: 10 },
    ]);
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier', 'Sana'));
    await tile(page, 'Charger 20W').click();
    await showCart(page);
    await expect(page.getByTestId('badge-below-cost')).toHaveText(
      'Below cost!',
    );
    await page.getByRole('button', { name: /Take payment/ }).click();
    const override = page.getByRole('dialog', { name: 'Manager PIN needed' });
    await expect(override).toContainText('below cost');
    await expect(override.getByLabel('Manager', { exact: true })).toHaveValue(
      /.+/,
    );
    await override.getByLabel('Manager PIN').fill('1111');
    await override.getByRole('button', { name: 'Approve' }).click();
    await expect(override.getByText('PIN not accepted.')).toBeVisible();
    await override.getByLabel('Manager PIN').fill('4826');
    await override.getByRole('button', { name: 'Approve' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Take payment' }),
    ).toBeVisible();
  });

  test('AC 5, 6: three carts survive reload; hold and resume restore lines, discounts and customer', async ({
    page,
  }) => {
    await openSell(page, [
      { name: 'Cable', price: 50000, stock: 10 },
      { name: 'Cover', price: 80000, stock: 10 },
      { name: 'Glass', price: 30000, stock: 10 },
    ]);
    await tile(page, 'Cable').click();
    await page.keyboard.press('Control+2');
    await tile(page, 'Cover').click();
    await page.keyboard.press('Control+3');
    await tile(page, 'Glass').click();
    await expect(page.getByTestId('cart-dot')).toHaveCount(3);
    await page.reload();
    await showCart(page);
    await expect(page.getByTestId('cart-dot')).toHaveCount(3);
    for (const [n, name] of [
      [1, 'Cable'],
      [2, 'Cover'],
      [3, 'Glass'],
    ] as const) {
      await page.getByRole('tab', { name: new RegExp(`Bill ${n}`) }).click();
      await expect(page.getByTestId('line-name')).toHaveText([name]);
    }

    // Bill 3: add a customer and a line discount, then hold.
    await page.getByRole('button', { name: 'Change' }).click();
    const cust = page.getByRole('dialog', { name: 'Customer' });
    await cust.getByRole('button', { name: '+ New customer' }).click();
    await cust.getByLabel('Customer name').fill('Bilal');
    await cust.getByRole('button', { name: 'Save customer' }).click();
    await expect(page.getByTestId('cart-customer')).toHaveText('Bilal');
    await page
      .getByTestId('cart-line')
      .getByRole('button', { name: /^Glass/ })
      .click();
    await page.getByLabel('Discount', { exact: true }).fill('50');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 250');
    await page.getByRole('button', { name: /^Hold/ }).click();
    const hold = page.getByRole('dialog', { name: 'Hold this bill' });
    await expect(hold.getByLabel('Label')).toHaveValue('Bilal');
    await hold.getByRole('button', { name: 'Hold' }).click();
    await expect(page.getByTestId('cart-line')).toHaveCount(0);
    await expect(page.getByTestId('cart-customer')).toHaveText(
      'Walk-in customer',
    );

    await page
      .getByRole('button', { name: /^Held bills \(1\)/ })
      .first()
      .click();
    const held = page.getByRole('dialog', { name: 'Held bills' });
    await expect(held.getByTestId('held-bill')).toContainText('Bilal');
    await expect(held.getByTestId('held-bill')).toContainText('Rs 250');
    await held.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByTestId('cart-customer')).toHaveText('Bilal');
    await expect(page.getByTestId('line-name')).toHaveText(['Glass']);
    await expect(page.getByTestId('badge-discount')).toHaveText('−Rs 50');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 250');
  });

  test('AC 2: with 1,000 products a keystroke repaints results in under 50 ms', async ({
    page,
  }) => {
    await openSell(page);
    await page.evaluate(() => window.__bikriTest?.seedManyProducts(1000));
    await expect(page.getByTestId('sell-tile').first()).toBeVisible();
    const times = await page.evaluate(async () => {
      const input = document.getElementById('sell-search') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      const out: number[] = [];
      for (const text of [
        'c',
        'ca',
        'cab',
        'cabl',
        'cable',
        'cable 0',
        'cable 00',
        'cable 001',
      ]) {
        const t0 = performance.now();
        setter?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        out.push(performance.now() - t0);
      }
      return out.sort((a, b) => a - b);
    });
    const median = times[Math.floor(times.length / 2)] ?? 0;
    expect(median).toBeLessThan(50);
    await expect(page.getByTestId('sell-tile')).toHaveCount(1);
  });

  test('AC 9: Urdu — cart on the left, grid on the right, numbers stay LTR', async ({
    page,
  }) => {
    await openSell(page, [{ name: 'Cable', price: 149900, stock: 3 }]);
    await page.getByLabel('Language').selectOption('ur');
    await expect(
      page.getByRole('combobox', { name: 'تلاش یا اسکین' }),
    ).toBeVisible();
    await tile(page, 'Cable').click();
    await expect(tile(page, 'Cable')).toContainText('3 باقی');
    if (!isPhone(page)) {
      const cart = await page
        .getByRole('complementary', { name: 'کارٹ' })
        .boundingBox();
      const grid = await page
        .getByRole('region', { name: 'پروڈکٹس تلاش کریں' })
        .boundingBox();
      expect(cart && grid && cart.x < grid.x).toBe(true);
    }
    await showCart(page);
    const total = page.getByTestId('total-to-pay').locator('bdi');
    await expect(total).toHaveAttribute('dir', 'ltr');
    await expect(total).toHaveText('Rs 1,499');
    await expect(
      page.getByRole('button', { name: /ادائیگی لیں/ }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByLabel('زبان').selectOption('en');
  });

  test('two cart lines stay fully visible on phone and in Urdu', async ({
    page,
  }) => {
    await openSell(page, [
      { name: 'Galaxy A15', price: 4200000, stock: 5 },
      { name: 'Cable', price: 149900, stock: 3 },
    ]);
    await tile(page, 'Galaxy A15').click();
    await tile(page, 'Cable').click();
    await showCart(page);

    const measure = () =>
      page.evaluate(() => {
        const lines = [
          ...document.querySelectorAll('[data-testid="cart-line"]'),
        ];
        const list = lines[0]?.parentElement;
        const listBox = list?.getBoundingClientRect();
        const last = lines.at(-1)?.getBoundingClientRect();
        return {
          count: lines.length,
          scrollHeight: list?.scrollHeight ?? 0,
          clientHeight: list?.clientHeight ?? 0,
          lastBottom: last?.bottom ?? 0,
          listBottom: listBox?.bottom ?? 0,
        };
      });

    const expectFits = (m: Awaited<ReturnType<typeof measure>>) => {
      expect(m.count).toBe(2);
      expect(m.scrollHeight).toBeLessThanOrEqual(m.clientHeight + 1);
      expect(m.lastBottom).toBeLessThanOrEqual(m.listBottom + 1);
    };

    expectFits(await measure());

    if (isPhone(page)) await showProducts(page);
    await page.getByLabel(/Language|زبان/).selectOption('ur');
    await showCart(page);
    expectFits(await measure());
    if (isPhone(page)) await showProducts(page);
    await page.getByLabel(/Language|زبان/).selectOption('en');
  });

  test('line price and discount are editable without opening the detail panel', async ({
    page,
  }) => {
    await openSell(page, [
      { name: 'Galaxy A15', price: 4200000, cost: 3800000, stock: 5 },
    ]);
    await tile(page, 'Galaxy A15').click();
    await showCart(page);
    const line = page
      .getByTestId('cart-line')
      .filter({ hasText: 'Galaxy A15' });
    await expect(line.getByLabel('Unit price')).toBeVisible();
    await expect(line.getByLabel('Discount', { exact: true })).toBeVisible();
    if (!isPhone(page)) {
      const price = await line
        .getByLabel('Unit price')
        .locator('..')
        .boundingBox();
      const discount = await line
        .getByLabel('Discount', { exact: true })
        .locator('..')
        .boundingBox();
      expect(
        Math.abs((price?.y ?? 0) - (discount?.y ?? 0)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs((price?.width ?? 0) - (discount?.width ?? 0)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs((price?.height ?? 0) - (discount?.height ?? 0)),
      ).toBeLessThanOrEqual(1);
    }
    await line.getByLabel('Unit price').fill('43000');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 43,000');
    await line.getByLabel('Discount', { exact: true }).fill('500');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 42,500');
    await expect(page.getByTestId('badge-discount')).toHaveText('−Rs 500');
    const percent = line.getByRole('button', { name: '%', exact: true });
    await percent.click();
    await expect(percent).toHaveAttribute('aria-pressed', 'true');
    await line.getByLabel('Discount', { exact: true }).fill('10');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 38,700');
    await expect(page.getByTestId('badge-discount')).toHaveText('−Rs 4,300');
    await expectNoHorizontalScroll(page);
  });
});
