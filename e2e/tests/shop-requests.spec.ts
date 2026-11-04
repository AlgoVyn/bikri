import { expect, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  expectNoSeriousAxe,
  setLanguage,
} from './helpers.ts';
import { ORIGIN } from './syncHelpers.ts';

// Public shop requests and the operator approval queue (D-175). The public form is tested on
// both viewports; the operator console is desktop-only, like the rest of /admin.
for (const lang of ['en', 'ur'] as const) {
  test(`public shop request form (${lang})`, async ({ page }) => {
    await page.goto('/bikri/request');
    await page.waitForFunction(() => window.__bikriTest !== undefined);
    if (lang === 'ur') await setLanguage(page, 'ur');
    const stamp = Date.now();
    const shop = `Request ${stamp}`;
    await page.getByTestId('register-shop-name').fill(shop);
    await page.getByTestId('register-owner-name').fill('Owner');
    await page.getByTestId('register-email').fill(`request-${stamp}@e2e.test`);
    await page.getByTestId('register-phone').fill('03001234567');
    await page.getByTestId('register-city').fill('Lahore');
    await page.getByTestId('register-note').fill('Please review my shop');
    await expectNoHorizontalScroll(page);
    await expectNoSeriousAxe(page);
    await page.getByTestId('register-submit').click();
    await expect(page.getByTestId('register-success')).toBeVisible();
    const link = page.getByTestId('register-status-link');
    await expect(link).toHaveAttribute('href', /\/request-status#/);
    await link.click();
    await expect(page.getByTestId('register-status')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousAxe(page);
    await expect(page.getByTestId('register-status-label')).toContainText(
      lang === 'en' ? 'Waiting for review' : 'جائزے کا انتظار',
    );
  });
}

test('enrol page links new visitors to the request form', async ({ page }) => {
  await page.goto('/bikri/enrol');
  const link = page.getByRole('link', { name: 'Request a shop' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(
    page.getByRole('heading', { name: 'Request a Bikri shop' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Connect this device' }),
  ).toBeVisible();
});

test.describe('operator request approval', () => {
  test.beforeEach(({ browserName: _b }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'operator console is desktop',
    );
  });

  test('reviews, manually verifies when Cloudflare is not configured, and approves', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now();
    const shop = `Requested shop ${stamp}`;
    const email = `operator-${stamp}@e2e.test`;
    const created = await page.request.post('/bikri/api/public/shop-requests', {
      headers: { origin: ORIGIN },
      data: {
        shop_name: shop,
        owner_name: 'Requested Owner',
        email,
        phone: '03001234567',
        city: 'Lahore',
        business_type: 'mobile',
        note: 'Operator queue e2e',
      },
    });
    expect(created.status(), await created.text()).toBe(202);

    await page.goto('/bikri/admin/requests');
    await expect(
      page.getByRole('heading', { name: 'Shop requests' }),
    ).toBeVisible();
    await page.getByPlaceholder('Shop, owner, email or phone').fill(email);
    await page.getByRole('link', { name: new RegExp(shop) }).click();
    await expect(page.getByRole('heading', { name: shop })).toBeVisible();
    await expectNoSeriousAxe(page);

    // No Cloudflare API token in e2e: the add action falls back to the manual verification.
    await page.getByTestId('request-email-add').click();
    await expect(page.getByTestId('request-email-manual')).toBeVisible();
    await page.getByTestId('request-email-manual').click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByTestId('request-email-manual-note')
      .fill('Checked the Cloudflare dashboard');
    await dialog.getByTestId('request-email-manual-submit').click();
    await expect(page.getByTestId('request-approve')).toBeEnabled();

    await page.getByTestId('request-approve').click();
    await page.getByTestId('request-approve-confirm').click();
    await expect(
      page.getByRole('region', { name: 'Pairing code — shown once' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Pairing code — shown once' }),
    ).toContainText(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    await expect(page.getByRole('link', { name: 'Open shop' })).toBeVisible();
  });
});
