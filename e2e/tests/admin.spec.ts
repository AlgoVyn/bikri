import { expect, test } from '@playwright/test';

// T-031 (screens/19): the operator console against `wrangler dev`, where Access is not enforced
// for the local operator (13 §7.1). Desktop only.
test.beforeEach(({ browserName: _b }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'operator console is desktop');
});

test('operator console: overview, new shop with a one-time code, read-only and reactivate', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/bikri/admin');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Platform operator')).toBeVisible();
  // The console never opens a shop database or the PIN lock.
  await expect(page.getByTestId('lock-screen')).toHaveCount(0);

  await page.getByRole('link', { name: 'Shops' }).click();
  await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();
  await page.getByRole('link', { name: 'New shop' }).first().click();
  await expect(page.getByText('What happens next')).toBeVisible();
  const slug = `ui-${Date.now().toString(36)}`;
  await page.getByLabel('Display name').fill(`Console ${slug}`);
  await page.getByLabel('Slug').fill(slug);
  await expect(page.getByText('Available.')).toBeVisible();
  await page.getByLabel('Owner email').fill(`${slug}@e2e.test`);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Pairing code — shown once')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Pairing code — shown once' }),
  ).toContainText(/[A-Z0-9]{4}-[A-Z0-9]{4}/);

  // The shop's page: make it read-only with a reason, then reactivate.
  await page.goto('/bikri/admin/tenants');
  await page.getByLabel('Search shops').fill(slug);
  await page.getByRole('link', { name: `Console ${slug}` }).click();
  await page.getByRole('button', { name: 'Make read-only' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Payment overdue (e2e)');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(/Read-only since/)).toBeVisible();
  await page.getByRole('button', { name: 'Reactivate' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Paid (e2e)');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm' })
    .click();
  await expect(page.getByText(/Active since/)).toBeVisible();
  await expect(page.getByText(/Payment overdue \(e2e\)/)).toBeVisible();
});

test('operator console follows the language switcher and RTL direction', async ({
  page,
}) => {
  await page.goto('/bikri/admin');
  await page.getByLabel('Language').selectOption('ur');
  await expect(page.getByRole('heading', { name: 'جائزہ' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('link', { name: 'دکانیں' })).toBeVisible();
});
