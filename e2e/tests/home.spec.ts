import { expect, type Page, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  expectNoSeriousAxe,
  openReadyShop,
  setLanguage,
} from './helpers.ts';

// T-013: app shell + Home (screens/04).

async function openWithSales(page: Page): Promise<void> {
  await openReadyShop(page, '/bikri/');
  await page.evaluate(() => window.__bikriTest?.seedTodaySales());
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 1024;

test.describe('Home and shell (T-013)', () => {
  test('English: Today figures, recent bills, rail, search and N', async ({
    page,
  }) => {
    await openWithSales(page);
    await expect(
      page.getByRole('heading', { name: 'Assalam-o-Alaikum, Adnan' }),
    ).toBeVisible();
    await expect(page.getByTestId('today-sold')).toContainText('1,000');
    await expect(page.getByTestId('today-sold')).toContainText('2 bills');
    await expect(page.getByTestId('today-profit')).toContainText('400');
    await expect(page.getByTestId('today-cash')).toContainText('750');
    await expect(page.getByTestId('today-udhaar')).toContainText(
      'Given Rs 300',
    );
    await expect(page.getByTestId('today-udhaar')).toContainText(
      'Received Rs 100',
    );
    const recent = page.getByRole('region', { name: 'Recent bills' });
    await expect(
      recent.getByRole('link').filter({ hasText: 'A-A-2' }).first(),
    ).toContainText('A-A-2');
    await expect(
      page.getByRole('heading', { name: 'Needs attention' }),
    ).toHaveCount(0);
    await expect(page.getByTestId('sync-badge')).toHaveAttribute(
      'data-state',
      'pending',
    );
    await expect(page.getByTestId('printer-dot')).toHaveAttribute(
      'aria-label',
      'No printer. Printer not set up',
    );
    await expect(page.getByTestId('printer-dot')).toHaveText('No printer');
    await expect(page.getByTestId('printer-dot')).toHaveClass(/bg-surface-2/);
    await expect(page.getByTestId('printer-dot')).toHaveClass(
      /text-text-muted/,
    );

    const nav = page.getByRole('navigation', { name: 'Main' });
    if (isPhone(page)) {
      await expect(nav.getByRole('link', { name: /Suppliers/ })).toBeHidden();
      await nav.getByRole('button', { name: 'More' }).click();
      await expect(
        page.locator('#more-menu').getByRole('link', { name: 'Suppliers' }),
      ).toBeVisible();
      await page
        .locator('#more-menu')
        .getByRole('link', { name: 'Reports' })
        .click();
      await expect(page).toHaveURL(/\/bikri\/reports$/);
      await nav.getByRole('link', { name: /Home/ }).click();
    } else {
      await expect(page.getByTestId('brand-rail')).toContainText('Bikri');
      await expect(page.getByTestId('rail-shop-name')).toHaveText(
        'Algovyn Mobiles',
      );
      for (const name of [
        'Home',
        'Sell',
        'Products',
        'Sales',
        'Udhaar',
        'Suppliers',
        'Expenses',
        'Reports',
        'Settings',
      ]) {
        await expect(
          nav.getByRole('link', { name: new RegExp(`^${name}`) }),
        ).toBeVisible();
      }
      await page.keyboard.press('Control+Shift+Digit8');
      await expect(page).toHaveURL(/\/bikri\/reports$/);
      await page.keyboard.press('Control+Shift+Digit1');
    }
    await expect(
      page.getByRole('heading', { name: 'Assalam-o-Alaikum, Adnan' }),
    ).toBeVisible();
    await expectNoSeriousAxe(page);

    await page.keyboard.press('/');
    const search = page.locator('#global-search');
    await expect(search).toBeFocused();
    await search.fill('A-A-1');
    await expect(page.getByRole('option', { name: /A-A-1/ })).toBeVisible();
    await search.press('Enter');
    await expect(page).toHaveURL(/\/bikri\/sales\/[A-Z0-9]+$/);

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /Home/ })
      .click();
    await page.locator('body').press('n');
    await expect(page).toHaveURL(/\/bikri\/sell$/);
  });

  test('Urdu: RTL Home with the same figures', async ({ page }) => {
    await openWithSales(page);
    await setLanguage(page, 'ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { name: 'السلام علیکم، Adnan' }),
    ).toBeVisible();
    await expect(page.getByTestId('today-sold')).toContainText('1,000');
    await expect(page.getByText('آج کی فروخت')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'حالیہ بل' })).toBeVisible();
    await expectNoSeriousAxe(page);
    await expectNoHorizontalScroll(page);
    await setLanguage(page, 'en');
  });

  test('Roman Urdu: translated Home without raw keys', async ({ page }) => {
    await openWithSales(page);
    await setLanguage(page, 'roman-ur');
    await expect(page.locator('html')).toHaveAttribute('lang', 'roman-ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(
      page.getByRole('heading', { name: 'Assalam-o-Alaikum, Adnan' }),
    ).toBeVisible();
    await expect(page.getByText('Aaj ki farokht')).toBeVisible();
    await expect(page.getByText('home.greeting')).toHaveCount(0);
    await setLanguage(page, 'en');
  });

  test('Ctrl+K opens commands and ? opens the shortcut sheet', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await page.keyboard.press('Control+k');
    const commands = page.getByRole('dialog', { name: 'Commands' });
    await expect(commands).toBeVisible();
    await expectNoSeriousAxe(page);
    await commands.getByLabel('Search commands…').fill('day close');
    await commands.getByRole('option', { name: /Day close/ }).click();
    await expect(page).toHaveURL(/\/bikri\/day-close$/);
    await page.keyboard.press('?');
    await expect(
      page.getByRole('dialog', { name: 'Keyboard shortcuts' }),
    ).toBeVisible();
  });

  test('an empty shop can load a starter catalogue', async ({ page }) => {
    await openReadyShop(page, '/bikri/');
    await page.getByRole('button', { name: 'Load sample products' }).click();
    await expect(page.getByText('8 sample products added.')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Get started' }),
    ).toBeVisible();
  });

  test('the staff menu switches language', async ({ page }) => {
    await openReadyShop(page, '/bikri/');
    await page.getByTestId('staff-menu').click();
    await expectNoSeriousAxe(page);
    await page.getByRole('radio', { name: 'اردو' }).locator('..').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await setLanguage(page, 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('the status popover links sync and printer to settings', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'the full status trigger is desktop-only',
    );
    await openReadyShop(page, '/bikri/');
    await page.getByTestId('sync-badge').click();
    await expectNoSeriousAxe(page);
    const pill = page.getByTestId('sync-pill');
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(page).toHaveURL(/\/bikri\/settings\/sync$/);
  });

  test('a cashier sees no Suppliers, profit or drawer cash, and is turned away by URL', async ({
    page,
  }) => {
    await openWithSales(page);
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier', 'Sana'));
    await expect(
      page.getByRole('heading', { name: 'Assalam-o-Alaikum, Sana' }),
    ).toBeVisible();
    await expect(page.getByTestId('today-profit')).toHaveCount(0);
    await expect(page.getByTestId('today-cash')).toHaveCount(0);
    await expect(page.getByTestId('today-sold')).toContainText('1,000');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: /^Suppliers/ })).toHaveCount(0);
    await page.evaluate(() => window.__bikriTest?.navigate('/suppliers'));
    await expect(page.getByText("You don't have access")).toBeVisible();
    await expect(page).toHaveURL(/\/bikri\/$/);
    await page.evaluate(() => window.__bikriTest?.navigate('/labels'));
    await expect(page.getByTestId('permission-no-access')).toBeVisible();
  });

  test('read-only, support and offline banners', async ({ page, context }) => {
    await openReadyShop(page, '/bikri/');
    await page.evaluate(async () => {
      await window.__bikriTest?.setKv('tenant_status', {
        status: 'read_only',
        since: 1,
      });
      await window.__bikriTest?.setKv('support', {
        until: Date.now() + 3_600_000,
        reason: 'Fix stock',
      });
    });
    await expect(page.getByTestId('banner-read-only')).toContainText(
      'This shop is read-only.',
    );
    await expect(page.getByTestId('banner-support')).toContainText(
      'Reason: Fix stock.',
    );
    await page.evaluate(() => window.__bikriTest?.navigate('/udhaar'));
    await expect(
      page.getByRole('button', { name: /New customer/ }).first(),
    ).toBeDisabled();
    await page.evaluate(() => window.__bikriTest?.navigate('/expenses'));
    await expect(
      page.getByRole('button', { name: /New expense/ }).first(),
    ).toBeDisabled();
    await page.evaluate(() => window.__bikriTest?.navigate('/day-close'));
    await expect(
      page.getByRole('button', { name: /Close day/ }).first(),
    ).toBeDisabled();
    await page.evaluate(() => window.__bikriTest?.navigate('/'));
    await context.setOffline(true);
    await expect(page.getByTestId('banner-offline')).toContainText(
      'Offline — sales are saved on this device',
    );
    await context.setOffline(false);
    await expect(page.getByTestId('banner-offline')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('staff menu shows a lock icon', async ({ page }) => {
    await openReadyShop(page, '/bikri/');
    await page.getByRole('button', { name: 'Staff menu' }).click();
    await expect(
      page.getByRole('button', { name: /Lock/ }).locator('svg'),
    ).toHaveCount(1);
    await expect(
      page.getByTestId('staff-menu-user').locator('svg'),
    ).toHaveCount(1);
  });

  test('printer pill turns green when a printer is configured', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await page.evaluate(async () => {
      await window.__bikriTest?.setKv('printer', { transport: 'system' });
    });
    await expect(page.getByTestId('printer-dot')).toHaveClass(
      /bg-success-subtle/,
    );
    await expect(page.getByTestId('printer-dot')).toHaveClass(
      /text-success-subtle-ink/,
    );
    await expect(page.getByTestId('printer-dot')).toHaveAttribute(
      'aria-label',
      'Printer ready',
    );
  });

  for (const size of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
  ]) {
    test(`no horizontal scroll at ${size.width}×${size.height} (AC 5)`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== 'desktop',
        'one pass covers all sizes',
      );
      await page.setViewportSize(size);
      await openWithSales(page);
      await expect(page.getByTestId('today-sold')).toBeVisible();
      await expectNoHorizontalScroll(page);
      await setLanguage(page, 'ur');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expectNoHorizontalScroll(page);
      await setLanguage(page, 'en');
    });
  }
});
