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

/** No element may stick out past the viewport (screens/04 AC 5). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

declare global {
  interface Window {
    __bikriTest?: {
      seedReadyShop: () => Promise<void>;
      reset: () => Promise<void>;
      unlockAs: (
        role: 'owner' | 'manager' | 'cashier',
        name?: string,
      ) => Promise<string>;
      seedTodaySales: () => Promise<void>;
      setKv: (key: string, value: unknown) => Promise<void>;
      navigate: (to: string) => Promise<void>;
    };
  }
}
