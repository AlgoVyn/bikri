import { expect, test } from '@playwright/test';
import { openReadyShop } from './helpers.ts';

// 08 §7 runtime budgets. The unthrottled keystroke stays under 50 ms in sell.spec.ts;
// these guards run the counter interactions at 4× CPU so a regression on a slow till is
// caught too. The budget scales with the throttle (50/80/100/150 ms × 4).
//
// The interaction and the wait both run in the page. Waiting with
// `requestAnimationFrame` would measure the 4× throttle itself (rAF drops to a few
// frames per second), not the app; a MutationObserver resolves on the actual DOM update.

/** The CDP session only exists on Chromium, which is what the POS ships on. */
async function throttle(page: import('@playwright/test').Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

test('Sell search stays under the keystroke budget at 4× CPU', async ({
  page,
}) => {
  await openReadyShop(page, '/bikri/sell');
  await page.evaluate(() => window.__bikriTest?.seedManyProducts(1000));
  await expect(page.getByTestId('sell-tile').first()).toBeVisible();

  await throttle(page);

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
      await new Promise((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0)),
      );
      out.push(performance.now() - t0);
    }
    return out.sort((a, b) => a - b);
  });

  const median = times[Math.floor(times.length / 2)] ?? 0;
  expect(median).toBeLessThan(200);
});

test('Scan to cart line stays under the 4× budget', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'the cart line is directly visible only on desktop',
  );
  await openReadyShop(page, '/bikri/sell');
  await page.evaluate(
    (list) => window.__bikriTest?.seedProducts(list),
    [
      { name: 'Cable', price: 50000, barcode: '8800000000998', stock: 20 },
      { name: 'Adapter', price: 50000, barcode: '8800000000999', stock: 20 },
    ],
  );
  await expect(page.getByTestId('sell-tile').first()).toBeVisible();
  await page.locator('#sell-search').focus();
  await throttle(page);

  // Warm the cart/live-query path; the budget is steady-state, not first-touch IDB.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const input = document.getElementById(
          'sell-search',
        ) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(input, '8800000000998');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
          }),
        );
        const observer = new MutationObserver(() => {
          if (document.querySelector('[data-testid="cart-line"]') !== null) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }),
  );

  const elapsed = await page.evaluate(
    (code) =>
      new Promise<number>((resolve, reject) => {
        const input = document.getElementById(
          'sell-search',
        ) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(input, code);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const before = document.querySelectorAll(
          '[data-testid="cart-line"]',
        ).length;
        const started = performance.now();
        const done = () => {
          const lines = document.querySelectorAll(
            '[data-testid="cart-line"]',
          ).length;
          if (lines > before) {
            observer.disconnect();
            resolve(performance.now() - started);
            return true;
          }
          return false;
        };
        const observer = new MutationObserver(done);
        observer.observe(document.body, { childList: true, subtree: true });
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
          }),
        );
        if (done()) return;
        setTimeout(() => {
          observer.disconnect();
          reject(new Error('scan did not add a cart line'));
        }, 3_000);
      }),
    '8800000000999',
  );
  // 80 ms × 4, plus the DOM commit that makes the line observable; the observer
  // resolves after React paints the new cart line, not at the input handler.
  expect(elapsed).toBeLessThan(480);
});

test('Pay modal opens under the 4× budget', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'the counter hotkeys are measured on the desktop profile',
  );
  await openReadyShop(page, '/bikri/sell');
  await page.evaluate(
    (list) => window.__bikriTest?.seedProducts(list),
    [{ name: 'Cable', price: 50000, stock: 20 }],
  );
  await page.getByTestId('sell-tile').first().click();
  await throttle(page);
  // Warm the dialog; the budget is the steady-state open, not first module parse.
  await page.keyboard.press('F8');
  await expect(
    page.getByRole('dialog', { name: 'Take payment' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Take payment' })).toHaveCount(
    0,
  );

  const elapsed = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const started = performance.now();
        const done = () => {
          if (document.querySelector('[role="dialog"]') !== null) {
            observer.disconnect();
            resolve(performance.now() - started);
            return true;
          }
          return false;
        };
        const observer = new MutationObserver(done);
        observer.observe(document.body, { childList: true, subtree: true });
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'F8',
            code: 'F8',
            bubbles: true,
          }),
        );
        if (done()) return;
        setTimeout(() => {
          observer.disconnect();
          reject(new Error('Pay dialog did not open'));
        }, 3_000);
      }),
  );
  // 100 ms × 4.
  expect(elapsed).toBeLessThan(400);
});

test('Done saves the bill under the 4× budget', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'the counter hotkeys are measured on the desktop profile',
  );
  await openReadyShop(page, '/bikri/sell');
  await page.evaluate(
    (list) => window.__bikriTest?.seedProducts(list),
    [{ name: 'Cable', price: 50000, stock: 20 }],
  );
  await page.getByTestId('sell-tile').first().click();
  await page.keyboard.press('F8');
  await expect(
    page.getByRole('dialog', { name: 'Take payment' }),
  ).toBeVisible();
  await throttle(page);
  // Warm the sale transaction; the budget is steady-state, not the first Dexie write.
  await page.getByTestId('pay-done').click();
  await expect(page.getByTestId('sale-saved')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sale-saved')).toHaveCount(0);
  await page.getByTestId('sell-tile').first().click();
  await page.keyboard.press('F8');
  await expect(
    page.getByRole('dialog', { name: 'Take payment' }),
  ).toBeVisible();

  const elapsed = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const button = document.querySelector(
          '[data-testid="pay-done"]',
        ) as HTMLButtonElement | null;
        if (button === null) {
          reject(new Error('Done button missing'));
          return;
        }
        const started = performance.now();
        const done = () => {
          if (document.querySelector('[data-testid="sale-saved"]') !== null) {
            observer.disconnect();
            resolve(performance.now() - started);
            return true;
          }
          return false;
        };
        const observer = new MutationObserver(done);
        observer.observe(document.body, { childList: true, subtree: true });
        button.click();
        if (done()) return;
        setTimeout(() => {
          observer.disconnect();
          reject(new Error('sale was not saved'));
        }, 5_000);
      }),
  );
  // 150 ms × 4.
  expect(elapsed).toBeLessThan(600);
});
