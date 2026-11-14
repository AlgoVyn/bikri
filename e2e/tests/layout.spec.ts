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
    const rail = page.getByTestId('rail-scroll');
    const metrics = await nav.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      labels: Array.from(
        element.querySelectorAll<HTMLElement>('a > span:last-child'),
      ).map((label) => getComputedStyle(label).whiteSpace),
    }));
    const scroll = await rail.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        scrollbarWidth: style.scrollbarWidth,
        overflowY: style.overflowY,
      };
    });
    expect(metrics.width).toBeGreaterThanOrEqual(88);
    expect(scroll.scrollbarWidth).toBe('none');
    expect(scroll.overflowY).toBe('auto');
    expect(metrics.labels.length).toBeGreaterThanOrEqual(8);
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

  test('desktop rail compacts from the brand and remembers it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openReadyShop(page, '/bikri/');
    const nav = page.getByTestId('brand-rail').locator('..');
    await expect(nav).toHaveCSS('width', '88px');
    await expect(page.getByTestId('brand-rail')).toHaveAttribute(
      'aria-label',
      'Bikri — Compact',
    );
    await expect(page.getByTestId('brand-rail')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await page.getByTestId('brand-rail').click();
    await expect(nav).toHaveCSS('width', '64px');
    await expect(page.locator('main')).toHaveCSS('padding-left', '64px');
    await expect(page.locator('nav .rail-label').first()).toBeHidden();
    await expect(page.getByTestId('brand-rail')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('brand-rail')).toHaveAttribute(
      'title',
      'Expand',
    );
    await page.reload();
    await expect(nav).toHaveCSS('width', '64px');
    await page.getByTestId('brand-rail').click();
    await expect(nav).toHaveCSS('width', '88px');
    await expect(page.locator('nav .rail-label').first()).toBeVisible();
  });

  test('desktop rail spaces nav items and keeps search at the bottom', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openReadyShop(page, '/bikri/');
    const links = page.getByTestId('rail-scroll').locator('a');
    const boxes = await links.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      }),
    );
    expect(boxes).toHaveLength(8);
    expect(Math.min(...boxes.map((box) => box.height))).toBeGreaterThanOrEqual(
      56,
    );
    const search = await page.getByTestId('rail-search').boundingBox();
    const lastNavBottom = Math.max(...boxes.map((box) => box.bottom));
    expect(search?.y ?? 0).toBeGreaterThan(lastNavBottom);
    const staff = await page.getByTestId('staff-menu').boundingBox();
    expect(staff?.y ?? 0).toBeGreaterThan(search?.y ?? 0);
  });

  test('the page More menu stays inside the phone viewport in both directions', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReadyShop(page, '/bikri/products');
    for (const language of ['en', 'ur'] as const) {
      await setLanguage(page, language);
      await page.getByTestId('page-actions-more').click();
      const menu = page.locator('.bikri-menu');
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 999)).toBeLessThanOrEqual(390);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    }
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

test.describe('typography and RTL identifiers', () => {
  test.beforeEach(({ page }, testInfo) => {
    if (testInfo.project.name !== 'desktop') {
      test.skip();
      return;
    }
    void page;
  });

  test('Urdu keeps compact leading and LTR identifier fields', async ({
    page,
  }) => {
    await seedVisualShop(page);
    await setLanguage(page, 'ur');
    await page.evaluate(() => window.__bikriTest?.navigate('/settings/shop'));
    await page.waitForTimeout(600);

    // `text-receipt` is 10 px with a 1.25 line-height; the old universal Urdu rule
    // forced 1.7 and made the printed-size preview too tall.
    const metrics = await page
      .locator('.text-receipt')
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: Number.parseFloat(style.lineHeight),
        };
      });
    expect(metrics.lineHeight / metrics.fontSize).toBeLessThan(1.4);

    const phone = page.locator('input[type="tel"]').first();
    await expect(phone).toHaveAttribute('dir', 'ltr');
    await setLanguage(page, 'en');
  });
});
