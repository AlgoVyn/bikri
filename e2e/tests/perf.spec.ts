import { expect, test } from '@playwright/test';
import { openReadyShop } from './helpers.ts';

// 08 §7 runtime budget: the unthrottled keystroke stays under 50 ms in sell.spec.ts.
// This guard runs the same interaction at 4× CPU so a regression on a slow till is
// caught too; the budget scales with the throttle (50 ms × 4).
test('Sell search stays under the keystroke budget at 4× CPU', async ({
  page,
}) => {
  await openReadyShop(page, '/bikri/sell');
  await page.evaluate(() => window.__bikriTest?.seedManyProducts(1000));
  await expect(page.getByTestId('sell-tile').first()).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

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
