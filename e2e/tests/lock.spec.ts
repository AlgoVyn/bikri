import { expect, test } from '@playwright/test';
import { createShop, enrol, newTill } from './syncHelpers.ts';

// D-202: the PIN keypad follows the device's keypad preference.
test('the lock keypad switches between phone and computer layouts', async ({
  browser,
  request,
}) => {
  const shop = await createShop(request, `lock-${Date.now()}@e2e.test`);
  const till = await newTill(browser);
  const page = till.page;
  await enrol(page, shop.owner_code.code);
  await page.waitForFunction(() => window.__bikriTest !== undefined);
  await page.evaluate(() => window.__bikriTest?.finishSetupHere());
  await page.goto('/bikri/');

  const lock = page.getByTestId('lock-screen');
  await expect(lock).toBeVisible({ timeout: 20_000 });
  const keypad = page.getByTestId('lock-keypad');
  await expect(keypad).toBeVisible();
  const digits = keypad.locator('button');
  const phone = [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'Clear',
    '0',
    '⌫',
  ];
  const computer = [
    '7',
    '8',
    '9',
    '4',
    '5',
    '6',
    '1',
    '2',
    '3',
    'Clear',
    '0',
    '⌫',
  ];
  expect(await digits.allTextContents()).toEqual(phone);

  await lock
    .getByRole('button', { name: 'Computer keypad (7 8 9 on top)' })
    .click();
  await expect.poll(() => digits.allTextContents()).toEqual(computer);

  // The choice is a device preference and survives a reload.
  await page.reload();
  await expect(lock).toBeVisible();
  await expect(keypad).toBeVisible();
  await expect.poll(() => digits.allTextContents()).toEqual(computer);

  await lock
    .getByRole('button', { name: 'Phone keypad (1 2 3 on top)' })
    .click();
  await expect.poll(() => digits.allTextContents()).toEqual(phone);
  await till.ctx.close();
});
