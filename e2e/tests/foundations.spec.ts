import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openReadyShop } from './helpers.ts';

// M0 smoke journeys: T-002 routing, T-005 PWA/offline, T-006 a11y, T-007 language switching.

test.describe('worker routing (T-002)', () => {
  test('API health is JSON and unknown API paths are JSON 404s', async ({
    request,
  }) => {
    const health = await request.get('/bikri/api/health');
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      db: 'ok',
      schema_version: 1,
    });
    const missing = await request.get('/bikri/api/does-not-exist');
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });

  test('/bikri redirects to /bikri/ and the HTML carries the CSP', async ({
    request,
  }) => {
    const redirect = await request.get('/bikri', { maxRedirects: 0 });
    expect([301, 307, 308]).toContain(redirect.status());
    expect(redirect.headers().location).toBe('/bikri/');
    const html = await request.get('/bikri/');
    expect(html.headers()['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(html.headers()['strict-transport-security']).toBe(
      'max-age=31536000',
    );
  });

  test('a deep link reloads into the app', async ({ page }) => {
    await openReadyShop(page, '/bikri/not-a-page');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'This page is not available.' }),
    ).toBeVisible();
  });
});

test.describe('shell and languages (T-006, T-007)', () => {
  test('English shell flips to Urdu RTL and back, and passes axe', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await expect(page).toHaveTitle('Bikri POS');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: /Sell/ })).toBeVisible();

    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);

    await page.getByLabel('Language').selectOption('ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ur');
    const navUr = page.getByRole('navigation', { name: 'مرکزی' });
    await expect(navUr.getByRole('link', { name: /بیچیں/ })).toBeVisible();
    const axeUr = await new AxeBuilder({ page }).analyze();
    expect(
      axeUr.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);

    // The choice survives a reload (localStorage `bikri.language`).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.getByLabel('زبان').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('Alt+3 opens Products from the rail', async ({ page }) => {
    await openReadyShop(page, '/bikri/');
    await page.keyboard.press('Alt+Digit3');
    await expect(page).toHaveURL(/\/bikri\/products$/);
  });
});

test.describe('PWA (T-005)', () => {
  test('service worker is scoped to /bikri/, the app loads offline, and / is not controlled', async ({
    page,
    context,
  }) => {
    await openReadyShop(page, '/bikri/');
    const scope = await page.evaluate(async () => {
      const reg = await (window as Window).navigator.serviceWorker.ready;
      return reg.scope;
    });
    expect(new URL(scope).pathname).toBe('/bikri/');
    await page.reload(); // now controlled by the service worker
    expect(
      await page.evaluate(
        () =>
          (window as Window).navigator.serviceWorker.controller?.scriptURL ??
          null,
      ),
    ).toMatch(/\/bikri\/sw\.js$/);
    expect(
      await page.evaluate(async () =>
        (await (window as Window).caches.keys()).every((k) =>
          k.startsWith('bikri'),
        ),
      ),
    ).toBe(true);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await page.goto('/bikri/settings');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await context.setOffline(false);

    // Outside /bikri/ (the Algovyn website in production) the service worker never takes control.
    await page.goto('/');
    expect(
      await page.evaluate(
        () => (window as Window).navigator.serviceWorker.controller,
      ),
    ).toBeNull();
  });

  test('manifest matches 01 §6', async ({ request }) => {
    const res = await request.get('/bikri/manifest.webmanifest');
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({
      id: '/bikri/',
      name: 'Bikri POS',
      short_name: 'Bikri',
      display: 'standalone',
      start_url: '/bikri/',
      scope: '/bikri/',
      theme_color: '#006BB3',
      background_color: '#F8FAFC',
    });
  });
});
