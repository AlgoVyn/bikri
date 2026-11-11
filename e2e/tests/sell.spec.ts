import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  openReadyShop,
  setLanguage,
} from './helpers.ts';

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
  test('Take payment on an empty bill focuses the search', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'the cart panel is always visible on desktop',
    );
    await openSell(page, [{ name: 'Cable', price: 50000, stock: 5 }]);
    const search = page.getByRole('combobox', { name: /Search or scan/ });
    await page.getByRole('button', { name: 'Take payment' }).click();
    await expect(search).toBeFocused();
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
      .getByRole('button', { name: 'More options' })
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
    await page.getByRole('button', { name: 'More options' }).click();
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
    await setLanguage(page, 'ur');
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
    await setLanguage(page, 'en');
  });

  test('two cart lines stay fully visible on phone and in Urdu', async ({
    page,
  }) => {
    await openSell(page, [
      { name: 'Galaxy A15', price: 4200000, stock: 5 },
      { name: 'Cable', price: 149900, stock: 3 },
    ]);
    const expectLines = async (count: number) => {
      if (isPhone(page)) {
        await expect(page.getByTestId('cart-bar')).toContainText(
          `${count} item`,
        );
      } else {
        await expect(page.getByTestId('cart-line')).toHaveCount(count);
      }
    };

    await tile(page, 'Galaxy A15').click();
    await expectLines(1);
    await tile(page, 'Cable').click();
    await expectLines(2);
    await showCart(page);
    await expect(page.getByTestId('cart-line')).toHaveCount(2);

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
    await setLanguage(page, 'ur');
    await showCart(page);
    await expect(page.getByTestId('cart-line')).toHaveCount(2);
    await page.waitForTimeout(100);
    expectFits(await measure());
    if (isPhone(page)) await showProducts(page);
    await setLanguage(page, 'en');
  });

  test('AC 10: fourteen lines fit on a 1080p screen with the active line open', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop density check');
    await page.setViewportSize({ width: 1920, height: 1080 });
    const names = [
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
      'Foxtrot',
      'Golf',
      'Hotel',
      'India',
      'Juliet',
      'Kilo',
      'Lima',
      'Mike',
      'November',
    ];
    const codes = names.map(
      (_, i) => `9900000000${String(i).padStart(3, '0')}`,
    );
    await openSell(
      page,
      names.map((name, i) => ({
        name,
        price: 10000 + i * 100,
        stock: 20,
        barcode: codes[i],
      })),
    );
    // Sell hides the app top bar entirely to give the cart the full height.
    await expect(page.getByTestId('screen-title-bar')).toHaveCount(0);
    await expect(page.getByTestId('sync-badge')).toHaveCount(0);
    // Scan instead of clicking tiles: the grid re-sorts after every add.
    for (const [i, code] of codes.entries()) {
      await scan(page, code);
      await expect(page.getByTestId('cart-line')).toHaveCount(i + 1);
    }
    await showCart(page);
    const measured = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('[data-testid="cart-line"]')];
      const list = lines[0]?.parentElement;
      return {
        count: lines.length,
        scrollHeight: list?.scrollHeight ?? 0,
        clientHeight: list?.clientHeight ?? 0,
      };
    });
    expect(measured.count).toBe(14);
    expect(measured.scrollHeight).toBeLessThanOrEqual(
      measured.clientHeight + 1,
    );
    await expectNoHorizontalScroll(page);
  });

  test('a typed search stays after adding; a barcode scan starts fresh', async ({
    page,
  }) => {
    await openSell(page, [
      {
        name: 'Cable short',
        price: 50000,
        stock: 10,
        barcode: '8800000000201',
      },
      {
        name: 'Cable long',
        price: 80000,
        stock: 10,
        barcode: '8800000000202',
      },
      {
        name: 'Charger',
        price: 150000,
        stock: 10,
        barcode: '8800000000203',
      },
    ]);
    const search = page.getByRole('combobox', { name: /Search or scan/ });
    await search.fill('Cable');
    await expect(page.getByTestId('sell-tile')).toHaveCount(2);
    await search.press('Enter');
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
    await expect(search).toHaveValue('Cable');

    // Click the *other* matching result so a second line is added, not merged.
    const first = await page.getByTestId('line-name').first().textContent();
    await tile(
      page,
      first === 'Cable long' ? 'Cable short' : 'Cable long',
    ).click();
    await expect(page.getByTestId('cart-line')).toHaveCount(2);
    await expect(search).toHaveValue('Cable');

    // The preserved query is selected, so a scanner replaces it; the scan then clears.
    await scan(page, '8800000000203');
    await expect(page.getByTestId('cart-line')).toHaveCount(3);
    await expect(search).toHaveValue('');
  });

  test('the active line edits price inline; More options holds the discount', async ({
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
    await expect(line.getByLabel('Discount', { exact: true })).toHaveCount(0);
    await line.getByLabel('Unit price').fill('43000');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 43,000');
    await line.getByRole('button', { name: 'More options' }).click();
    await expect(line.getByLabel('Discount', { exact: true })).toBeVisible();
    await line.getByLabel('Discount', { exact: true }).fill('500');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 42,500');
    await expect(page.getByTestId('badge-discount')).toHaveText('−Rs 500');
    const percent = line.getByRole('button', {
      name: /Discount in Rs or %/,
    });
    await percent.click();
    await expect(percent).toHaveAttribute('aria-pressed', 'true');
    await line.getByLabel('Discount', { exact: true }).fill('10');
    await expect(page.getByTestId('total-to-pay')).toHaveText('Rs 38,700');
    await expect(page.getByTestId('badge-discount')).toHaveText('−Rs 4,300');
    await expectNoHorizontalScroll(page);
  });
});
