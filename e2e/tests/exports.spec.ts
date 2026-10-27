import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openReadyShop } from './helpers.ts';

// T-049: the full local export zip (screens/17 AC 6, 09 §3.3).

test.describe('Exports (T-049)', () => {
  test('AC 6: downloads a full shop zip offline with every table', async ({
    page,
    context,
  }) => {
    await openReadyShop(page, '/bikri/');
    await page.evaluate(() => window.__bikriTest?.seedTodaySales());
    await page.goto('/bikri/settings/backup');
    await expect(
      page.getByRole('heading', { name: 'Backup & export' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Download from server' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Restore from export' }),
    ).toBeDisabled();

    await context.setOffline(true);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download full export' }).click(),
    ]);
    await context.setOffline(false);
    const bytes = await readFile((await download.path()) ?? '');
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const text = bytes.toString('latin1');
    expect(text).toContain('manifest.json');
    expect(text).toContain('json/sales.json');
    expect(text).toContain('csv/sales.csv');
    expect(text).toContain('"format": "bikri-export"');
    expect(text).toContain('"version": 2');
    expect(text).toContain('"tables"');
    expect(text).not.toContain('"tenant_id"');
    await expect(page.getByText(/Downloaded bikri-export-/u)).toBeVisible();
  });
});
