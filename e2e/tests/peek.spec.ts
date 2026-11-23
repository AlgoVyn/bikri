import { expect, test } from '@playwright/test';
import { openReadyShop } from './helpers.ts';

// Reference peek: a product line in a bill opens a read-only summary without losing
// the bill; closing returns to it and Open full keeps a back path to the origin.
test('a bill line opens a product peek and returns to the bill', async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === 'phone';
  await openReadyShop(page, '/bikri/sales');
  await page.evaluate(async () => {
    await window.__bikriTest?.seedTodaySales();
  });

  const openPeek = async () => {
    if (!(await page.getByTestId('bill-status').isVisible())) {
      await page.getByRole('link', { name: /A-A-/u }).first().click();
    }
    await expect(page.getByTestId('bill-status')).toBeVisible();
    await page
      .getByRole('link', { name: /Open product:/u })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Product reference');
    await expect(dialog).toContainText('From Bill');
    return dialog;
  };

  let dialog = await openPeek();
  if (phone) {
    await dialog.getByRole('button', { name: /Back to Bill A-A-/u }).click();
  } else {
    await dialog.getByRole('button', { name: 'Close' }).click();
  }
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('bill-status')).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Open product:/u }).first(),
  ).toBeFocused();

  dialog = await openPeek();
  await dialog.getByRole('button', { name: 'Open full product' }).click();
  await expect(page).toHaveURL(/\/bikri\/products\/[^/?]+$/u);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // A child edit screen must not lose the bill return context.
  await page
    .getByTestId('product-actions')
    .getByRole('link', { name: 'Edit', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (phone) {
    await expect(page.getByTestId('topbar-back')).toContainText(/Bill A-A-/u);
  } else {
    await expect(
      page.getByRole('link', { name: /Back to Bill A-A-/u }).first(),
    ).toBeVisible();
  }

  if (phone) {
    const topbarBack = page.getByTestId('topbar-back');
    await expect(topbarBack).toContainText(/Bill A-A-/u);
    await topbarBack.click();
  } else {
    await page
      .getByRole('link', { name: /Back to Bill A-A-/u })
      .first()
      .click();
  }
  await expect(page.getByTestId('bill-status')).toBeVisible();

  dialog = await openPeek();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('bill-status')).toBeVisible();
});

test('a bill customer opens a customer peek, then the khata', async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === 'phone';
  await openReadyShop(page, '/bikri/sales');
  await page.evaluate(async () => {
    await window.__bikriTest?.seedTodaySales();
  });
  await page.getByRole('link', { name: /A-A-2/u }).first().click();

  const customerLink = page
    .getByTestId('sales-detail')
    .getByRole('link', { name: 'Bilal', exact: true });
  await customerLink.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Customer reference');
  await expect(dialog).toContainText('12-A Gulberg III, Lahore');
  await dialog.getByRole('button', { name: 'Open khata' }).click();

  await expect(page).toHaveURL(/\/bikri\/udhaar\//u);
  if (phone) {
    await expect(page.getByTestId('topbar-back')).toContainText(/Bill A-A-/u);
    await page.getByTestId('topbar-back').click();
  } else {
    await page
      .getByRole('link', { name: /Back to Bill A-A-/u })
      .first()
      .click();
  }
  await expect(page.getByTestId('bill-status')).toBeVisible();
});

test('double-clicking a record link opens only one peek entry', async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === 'phone';
  await openReadyShop(page, '/bikri/sales');
  await page.evaluate(async () => {
    await window.__bikriTest?.seedTodaySales();
  });
  await page.getByRole('link', { name: /A-A-/u }).first().click();
  await page
    .getByRole('link', { name: /Open product:/u })
    .first()
    .evaluate((element) => {
      if (element instanceof HTMLElement) {
        element.click();
        element.click();
      }
    });

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  if (phone) {
    await dialog.getByRole('button', { name: /Back to Bill A-A-/u }).click();
  } else {
    await dialog.getByRole('button', { name: 'Close' }).click();
  }
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('bill-status')).toBeVisible();
});
