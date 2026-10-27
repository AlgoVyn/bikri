import { expect, type Page } from '@playwright/test';

/** Opens the app with a finished setup (bikri-dev, owner PIN 4826) and waits for the shell. */
export async function openReadyShop(
  page: Page,
  path = '/bikri/',
): Promise<void> {
  await page.goto('/bikri/setup');
  await page.waitForFunction(() => window.__bikriTest !== undefined);
  await page.evaluate(() => window.__bikriTest?.seedReadyShop());
  await page.goto(path);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

declare global {
  interface Window {
    __bikriTest?: {
      seedReadyShop: () => Promise<void>;
      reset: () => Promise<void>;
    };
  }
}
