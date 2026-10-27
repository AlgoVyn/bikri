import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { idbAll, openReadyShop } from './helpers.ts';

// T-047: day close and Z-report (screens/15 ACs 1–7).

async function counted(page: Page, amount: string) {
  await page.getByRole('button', { name: 'Total', exact: true }).click();
  await page.getByLabel('Total counted').fill(amount);
}

test.describe('Day close (T-047)', () => {
  test('AC 1–7: sample day closes a correct drawer, queues the Z-report and starts a new period', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await page.evaluate(() => window.__bikriTest?.seedTodaySales());
    await page.goto('/bikri/day-close');
    await expect(page.getByText('Expected in drawer')).toBeVisible();
    await counted(page, '750');
    await expect(page.getByText('Drawer is correct')).toBeVisible();
    await page.getByRole('button', { name: 'Close day' }).click();
    await expect(page.getByTestId('day-closed')).toBeVisible();
    const [close] = await idbAll<{
      expected_cash: number;
      counted_cash: number;
      difference: number;
      period_end: number;
    }>(page, 'day_closes');
    expect(close).toMatchObject({
      expected_cash: 75000,
      counted_cash: 75000,
      difference: 0,
    });
    const jobs = await idbAll<{ kind: string; day_close_id?: string }>(
      page,
      'print_jobs',
    );
    expect(
      jobs.find((j) => j.kind === 'day_close')?.day_close_id,
    ).toBeDefined();
    await page.getByRole('button', { name: 'Print Z-report' }).click();
    await expect(page.getByText('Z-report queued.')).toBeVisible();

    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'CSV' }).click(),
    ]);
    const csvText = await readFile((await csv.path()) ?? '', 'utf8');
    expect(csvText).toContain(
      'date,device,cashier,period_start,period_end,opening,cash_sales,udhaar_in,pay_ins,supplier_in,refunds,expenses,supplier_out,pay_outs,expected,counted,difference,card,bank,udhaar_given,bills,refunds_count,note',
    );
    expect(csvText).toContain('750.00');
    const [pdf] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'PDF' }).click(),
    ]);
    const pdfBytes = await readFile((await pdf.path()) ?? '');
    expect(pdfBytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
  });

  test('AC 4: a cashier sees the expected amount only after entering the count', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await page.evaluate(() => window.__bikriTest?.seedTodaySales());
    await page.evaluate(() => window.__bikriTest?.navigate('/day-close'));
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier'));
    await expect(page.getByRole('button', { name: 'Next' })).toBeVisible();
    await expect(page.getByText('Expected in drawer')).toHaveCount(0);
    await counted(page, '750');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Expected in drawer')).toBeVisible();
  });

  test('a short drawer needs a note and is audited', async ({ page }) => {
    await openReadyShop(page, '/bikri/day-close');
    await counted(page, '2000');
    await expect(page.getByText('Over')).toBeVisible();
    await expect(
      page.getByText('Write a note for a difference of Rs 100 or more.'),
    ).toBeVisible();
    await page.getByLabel('Note').fill('Opening float difference');
    await page.getByRole('button', { name: 'Close day' }).click();
    await expect(page.getByTestId('day-closed')).toBeVisible();
    const audit = await idbAll<{ action: string }>(page, 'audit_log');
    expect(audit.some((a) => a.action === 'day_close_difference')).toBe(true);
  });

  test('Urdu day close labels', async ({ page }) => {
    await openReadyShop(page, '/bikri/day-close');
    await page.getByLabel('Language').selectOption('ur');
    await expect(
      page.getByRole('heading', { name: 'دن کا حساب' }),
    ).toBeVisible();
    await expect(page.getByText('نقد گنیں')).toBeVisible();
  });
});
