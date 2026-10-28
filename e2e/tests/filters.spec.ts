import { expect, test } from '@playwright/test';
import { openReadyShop } from './helpers.ts';

// Date-range choices are per-device preferences and must survive navigation.
test.describe('remembered date filters', () => {
  test('Sales remembers the selected range', async ({ page }) => {
    await openReadyShop(page, '/bikri/sales');
    await page.getByRole('button', { name: '7 days' }).click();
    await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.goto('/bikri/');
    await page.goto('/bikri/sales');
    await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('Expenses offers last month and a remembered custom range', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/expenses');
    await page.getByRole('button', { name: 'Last month' }).click();
    await expect(
      page.getByRole('button', { name: 'Last month' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/bikri/');
    await page.goto('/bikri/expenses');
    await expect(
      page.getByRole('button', { name: 'Last month' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Custom', exact: true }).click();
    await page.getByLabel('From', { exact: true }).fill('2026-10-01');
    await page.getByLabel('To', { exact: true }).fill('2026-10-15');
    await page.goto('/bikri/');
    await page.goto('/bikri/expenses');
    await expect(page.getByLabel('From', { exact: true })).toHaveValue(
      '2026-10-01',
    );
    await expect(page.getByLabel('To', { exact: true })).toHaveValue(
      '2026-10-15',
    );
  });

  test('Reports remembers the selected range', async ({ page }) => {
    await openReadyShop(page, '/bikri/reports');
    await page.getByRole('button', { name: '30 days' }).click();
    await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.goto('/bikri/');
    await page.goto('/bikri/reports');
    await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
