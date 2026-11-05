import { expect, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  openReadyShop,
  setLanguage,
} from './helpers.ts';

// Design layout invariants (docs/design-review-checklist.md). The screenshot matrix is
// attached on demand with VISUAL=1; CI always checks the geometry.

const WIDTHS = [390, 768, 1280, 1920] as const;
const ROUTES = [
  '/',
  '/sell',
  '/products',
  '/sales',
  '/expenses',
  '/day-close',
  '/settings',
  '/reports',
] as const;

async function seedVisualShop(page: import('@playwright/test').Page) {
  await openReadyShop(page, '/bikri/');
  await page.evaluate(async () => {
    await window.__bikriTest?.seedManyProducts(40);
    await window.__bikriTest?.seedTodaySales();
  });
  await page.reload();
  await page.waitForSelector('nav:not([data-testid="breadcrumbs"])');
}

test.describe('design layout invariants', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'desktop') {
      test.skip();
      return;
    }
    await page.waitForLoadState('domcontentloaded');
  });

  test('no horizontal scroll at 390, 768, 1280 and 1920', async ({ page }) => {
    await seedVisualShop(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      for (const route of ROUTES) {
        await page.evaluate((to) => window.__bikriTest?.navigate(to), route);
        await page.waitForFunction(
          () => !document.querySelector('[aria-busy="true"]'),
        );
        await page.waitForTimeout(route === '/reports' ? 250 : 120);
        await expectNoHorizontalScroll(page);
        if (process.env.VISUAL === '1') {
          await test
            .info()
            .attach(`${route.replaceAll('/', '_') || 'home'}-${width}.png`, {
              body: await page.screenshot(),
              contentType: 'image/png',
            });
        }
      }
    }
  });

  test('Urdu core screens stay inside the viewport', async ({ page }) => {
    await seedVisualShop(page);
    await page.evaluate(() => localStorage.setItem('bikri.language', 'ur'));
    await page.reload();
    await page.waitForSelector('nav:not([data-testid="breadcrumbs"])');
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      for (const route of ['/', '/sell', '/products', '/sales'] as const) {
        await page.evaluate((to) => window.__bikriTest?.navigate(to), route);
        await page.waitForTimeout(250);
        await expectNoHorizontalScroll(page);
      }
    }
  });

  test('200% zoom equivalent keeps core screens inside 640x400', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 400 });
    await seedVisualShop(page);
    for (const route of [
      '/',
      '/sell',
      '/products',
      '/settings/shop',
    ] as const) {
      await page.evaluate((to) => window.__bikriTest?.navigate(to), route);
      await page.waitForTimeout(250);
      await expectNoHorizontalScroll(page);
    }
  });

  test('every till control is at least 44 px on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedVisualShop(page);
    await page.evaluate(() => window.__bikriTest?.navigate('/sell'));
    await page.waitForTimeout(300);
    await page.getByTestId('sell-tile').first().click();
    await page.getByTestId('cart-bar').click();
    await page.waitForTimeout(300);
    const small = await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return [];
      const nodes = Array.from(
        main.querySelectorAll<HTMLElement>(
          'button, a[href], input:not([type="hidden"]), select, textarea',
        ),
      );
      return nodes
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            !el.closest('.sr-only') &&
            !el.classList.contains('sr-only') &&
            (rect.width < 44 || rect.height < 44)
          );
        })
        .map((el) => ({
          tag: el.tagName,
          label:
            el.getAttribute('aria-label') ??
            (el.textContent ?? '').trim().slice(0, 30),
          width: Math.round(el.getBoundingClientRect().width),
          height: Math.round(el.getBoundingClientRect().height),
        }));
    });
    expect(small).toEqual([]);
  });

  test('desktop rail keeps labels on one line and hides its scrollbar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await seedVisualShop(page);
    const nav = page.getByTestId('brand-rail').locator('..');
    const metrics = await nav.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: element.getBoundingClientRect().width,
        scrollbarWidth: style.scrollbarWidth,
        overflowY: style.overflowY,
        labels: Array.from(
          element.querySelectorAll<HTMLElement>('a > span:last-child'),
        ).map((label) => getComputedStyle(label).whiteSpace),
      };
    });
    expect(metrics.width).toBeGreaterThanOrEqual(88);
    expect(metrics.scrollbarWidth).toBe('none');
    expect(metrics.overflowY).toBe('auto');
    expect(metrics.labels.length).toBeGreaterThanOrEqual(9);
    expect(metrics.labels.every((whiteSpace) => whiteSpace === 'nowrap')).toBe(
      true,
    );

    // Urdu labels are shorter in Latin width terms but use the larger Naskh metrics.
    await setLanguage(page, 'ur');
    const overflowed = await nav.evaluate((element) =>
      Array.from(element.querySelectorAll<HTMLElement>('a > span:last-child'))
        .filter((label) => label.scrollWidth > label.clientWidth + 1)
        .map((label) => label.textContent),
    );
    expect(overflowed).toEqual([]);
    await setLanguage(page, 'en');
  });

  test('list density holds at 1280', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedVisualShop(page);
    await page.evaluate(() => window.__bikriTest?.navigate('/products'));
    await page.waitForTimeout(300);
    const rows = page.locator('[aria-posinset]');
    await expect(rows.first()).toBeVisible();
    const height = await rows
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(60);
    expect(height).toBeGreaterThanOrEqual(44);
    expect(await rows.count()).toBeGreaterThanOrEqual(8);
    const visible = await rows.evaluateAll(
      (elements) =>
        elements.filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= window.innerHeight;
        }).length,
    );
    expect(visible).toBeGreaterThanOrEqual(8);
  });
});
