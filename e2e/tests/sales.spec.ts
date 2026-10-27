import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { idbAll, idbPut, idbUpdate, openReadyShop } from './helpers.ts';

// T-040/T-041/T-042: sales history, bill detail, refunds, void and reissue
// (screens/10 ACs 1–5, screens/11 ACs 1–8).

type Row = Record<string, unknown>;

const tile = (page: Page, name: string) =>
  page.getByTestId('sell-tile').filter({ hasText: name });

async function sellOne(page: Page, name = 'Earbuds', price = 350000) {
  await openReadyShop(page, '/bikri/sell');
  await page.evaluate(
    (p) => window.__bikriTest?.seedProducts(p),
    [{ name, price, cost: 200000, stock: 5 }],
  );
  await tile(page, name).click();
  await page.keyboard.press('F8');
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await expect(pay).toBeVisible();
  await pay.getByTestId('pay-done').click();
  const done = page.getByRole('dialog', { name: 'Sale complete' });
  await expect(done.getByTestId('sale-saved')).toBeVisible();
  await done.getByRole('button', { name: 'Open bill' }).click();
  await expect(page.getByTestId('bill-status')).toBeVisible();
}

test.describe('Sales history and refunds (T-040, T-041)', () => {
  test('AC 1, 4: history summary, part-refunded line quantities and the CSV header', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/sales');
    await page.evaluate(() => window.__bikriTest?.seedTodaySales());
    const summary = page.getByTestId('sales-summary');
    await expect(summary).toContainText('2');
    await expect(summary).toContainText('Rs 1,000');
    await expect(summary).toContainText('Rs 500');
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

    await page.getByRole('link', { name: /A-A-1/ }).click();
    await expect(page.getByTestId('bill-status')).toHaveText('Part refunded');
    const line = page.getByRole('row').filter({ hasText: 'Charger' });
    await expect(line).toContainText('Refunded: 1');
    await expect(line).toContainText('Kept: 1');

    await page.getByRole('link', { name: 'Back to sales' }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const path = await download.path();
    const csv = await readFile(path ?? '', 'utf8');
    expect(csv).toContain(
      'invoice_no,date,time,customer,items,subtotal,discounts,tax,total,cash,card,bank_wallet,udhaar,refunded,status,cashier,device',
    );
    expect(csv).toContain('A-A-1');
    expect(csv).toContain('A-A-2');
  });

  test('AC 5 + screens/11 AC 1: refund a bill, status/history rows, failed print stays red until a success', async ({
    page,
  }) => {
    await sellOne(page);
    await expect(page.getByTestId('bill-status')).toHaveText('Paid');
    await page.getByRole('button', { name: /^Refund\b/ }).click();
    const dialog = page.getByRole('dialog', { name: /Refund/ });
    await dialog.getByRole('button', { name: 'Faulty' }).click();
    await dialog.getByRole('button', { name: 'Refund Rs 3,500' }).click();
    await expect(dialog.getByTestId('refund-saved')).toHaveText(
      'Refund saved.',
    );
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('bill-status')).toHaveText('Refunded');
    await expect(page.getByText('Reason: Faulty')).toBeVisible();
    // AC 7: a fully refunded bill has no Refund button.
    await expect(page.getByRole('button', { name: /^Refund\b/ })).toHaveCount(
      0,
    );
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);

    const refunds = await idbAll<Row>(page, 'refunds');
    expect(refunds).toMatchObject([
      {
        exact_amount: 350000,
        amount: 350000,
        rounding: 0,
        method: 'cash',
        udhaar_part: 0,
      },
    ]);
    const payments = await idbAll<Row>(page, 'payments');
    expect(
      payments.filter((p) => p.purpose === 'refund').map((p) => p.amount),
    ).toEqual([350000]);
    const moves = await idbAll<Row>(page, 'stock_movements');
    expect(moves.filter((m) => m.reason_code === 'refund_return')).toHaveLength(
      1,
    );

    await page.getByRole('link', { name: 'Back to sales' }).click();
    const [sale] = await idbAll<{ id: string }>(page, 'sales');
    expect(sale).toBeDefined();
    await idbPut(page, 'print_jobs', {
      id: 'job-fail',
      sale_id: sale?.id,
      kind: 'sale',
      status: 'failed',
      error: 'NO_PRINTER',
      created_at: Date.now(),
    });
    await page.reload();
    const failed = page.getByRole('button', {
      name: 'Print failed — click to reprint',
    });
    await expect(failed).toBeVisible();
    await failed.click();
    await expect(failed).toBeVisible();
    await idbUpdate(page, 'print_jobs', 'job-fail', { status: 'done' });
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Print failed — click to reprint' }),
    ).toHaveCount(0);
  });
});

test.describe('Void and reissue (T-042)', () => {
  test('AC 2, 3: reissue voids the original in the new sale transaction; a plain void reverses cash and stock', async ({
    page,
  }) => {
    await sellOne(page);
    const original = await page
      .getByRole('heading', { level: 1 })
      .textContent();
    await page.getByRole('button', { name: 'Void & reissue' }).click();
    const reissue = page.getByRole('dialog', { name: 'Void & reissue' });
    await reissue.getByRole('button', { name: 'Wrong price' }).click();
    await reissue.getByRole('button', { name: 'Open Sell' }).click();
    await expect(page.getByTestId('reissue-banner')).toContainText(
      `Reissue of ${original ?? ''}`,
    );
    await expect(page.getByTestId('cart-line')).toContainText('Earbuds');
    await page.keyboard.press('F8');
    const pay = page.getByRole('dialog', { name: 'Take payment' });
    await pay.getByTestId('pay-done').click();
    const done = page.getByRole('dialog', { name: 'Sale complete' });
    await expect(done.getByTestId('sale-saved')).toBeVisible();
    await done.getByRole('button', { name: 'Open bill' }).click();
    await expect(page.getByTestId('bill-status')).toHaveText('Paid');

    await page.evaluate(() => window.__bikriTest?.navigate('/sales'));
    await expect(page.getByRole('link', { name: /A-A-1/ })).toBeVisible();
    await page.getByRole('link', { name: /A-A-1/ }).click();
    await expect(page.getByTestId('bill-status')).toHaveText('Void');
    await expect(page.getByText('Replaced by A-A-2')).toBeVisible();
    await expect(page.getByRole('link', { name: 'A-A-2' })).toBeVisible();
    const voids = await idbAll<Row>(page, 'sale_voids');
    expect(voids).toMatchObject([
      { sale_id: expect.any(String), replacement_sale_id: expect.any(String) },
    ]);

    // A plain void of a fresh bill: cash goes back out and stock returns.
    await page.evaluate(() => window.__bikriTest?.navigate('/sell'));
    await tile(page, 'Earbuds').click();
    await page.keyboard.press('F8');
    await page
      .getByRole('dialog', { name: 'Take payment' })
      .getByTestId('pay-done')
      .click();
    const done2 = page.getByRole('dialog', { name: 'Sale complete' });
    await done2.getByRole('button', { name: 'Open bill' }).click();
    await expect(page.getByTestId('bill-status')).toHaveText('Paid');
    await page.getByRole('button', { name: 'Void', exact: true }).click();
    const voidDialog = page.getByRole('dialog', { name: 'Void this bill?' });
    await expect(voidDialog).toContainText('Return Rs 3,500 to the customer');
    await expect(voidDialog).toContainText('Put 1 back in stock');
    await voidDialog
      .getByRole('button', { name: 'Customer cancelled' })
      .click();
    await voidDialog.getByRole('button', { name: 'Void bill' }).click();
    await expect(page.getByTestId('bill-status')).toHaveText('Void');
    const latest = await idbAll<Row>(page, 'sales');
    const voided = latest.find(
      (s) => s.status === 'void' && s.id !== voids[0]?.sale_id,
    );
    expect(voided).toBeDefined();
    const pays = await idbAll<Row>(page, 'payments');
    expect(
      pays.filter((p) => p.purpose === 'void' && p.sale_id === voided?.id),
    ).toMatchObject([{ direction: 'out', method: 'cash', amount: 350000 }]);
    const returns = await idbAll<Row>(page, 'stock_movements');
    expect(
      returns.filter(
        (m) => m.reason_code === 'void_return' && m.ref_id !== voids[0]?.id,
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Urdu refunds (screens/11 AC 4–6)', () => {
  test('a part-udhaar bill refunds cash first and takes the rest off the khata; RTL and axe', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/');
    await page.getByLabel('Language').selectOption('ur');
    await page.goto('/bikri/sales');
    await page.waitForFunction(() => window.__bikriTest !== undefined);
    await page.evaluate(() => window.__bikriTest?.seedTodaySales());
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('link', { name: /A-A-1/ })).toContainText(
      'کچھ رقم واپس',
    );
    await page.getByRole('link', { name: /A-A-2/ }).click();
    await page.getByRole('button', { name: /^رقم واپس/ }).click();
    const dialog = page.getByRole('dialog', { name: /A-A-2/ });
    await expect(dialog.getByText('ادا شدہ اور کھاتے کی تقسیم')).toBeVisible();
    await dialog.getByRole('button', { name: 'خراب' }).click();
    await dialog.getByRole('button', { name: /Rs 200/ }).click();
    await expect(dialog.getByTestId('refund-saved')).toHaveText(
      'واپسی محفوظ ہو گئی۔',
    );
    await dialog.getByRole('button', { name: 'بند کریں' }).click();
    await expect(page.getByTestId('bill-status')).toHaveText('واپس شدہ');
    const refunds = await idbAll<Row>(page, 'refunds');
    expect(refunds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          exact_amount: 50000,
          udhaar_part: 30000,
          amount: 20000,
          method: 'cash',
        }),
      ]),
    );
    const ledger = await dbLedger(page);
    expect(ledger).toContainEqual(
      expect.objectContaining({ source_type: 'refund', amount: -30000 }),
    );
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);
  });
});

async function dbLedger(page: Page): Promise<Row[]> {
  return idbAll<Row>(page, 'ledger_entries');
}
