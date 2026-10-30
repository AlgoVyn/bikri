import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { idbAll, openReadyShop } from './helpers.ts';

// T-045: suppliers, deliveries and paying a supplier (screens/13 ACs 1–5).

async function openSuppliers(page: Page) {
  await openReadyShop(page, '/bikri/suppliers');
}

async function newSupplier(page: Page, name = 'Hall Road Traders') {
  await page
    .getByRole('button', { name: /New supplier/ })
    .first()
    .click();
  const d = page.getByRole('dialog', { name: 'New supplier' });
  await d.getByLabel('Name').fill(name);
  await d.getByLabel('Phone').fill('03001234567');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(d).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: new RegExp(name) }),
  ).toBeVisible();
}

test.describe('Suppliers and deliveries (T-045)', () => {
  test('AC 1, 2, 3, 5: delivery raises stock/avg cost, paid-now is a cash out, balance is deliveries minus payments', async ({
    page,
  }) => {
    await openSuppliers(page);
    const [productId] =
      (await page.evaluate(() =>
        window.__bikriTest?.seedProducts([
          { name: 'Phone X', price: 500000, cost: 110000, stock: 20 },
        ]),
      )) ?? [];
    await newSupplier(page);
    await page.getByRole('link', { name: /Hall Road Traders/ }).click();
    await expect(page.getByTestId('supplier-balance')).toContainText('Settled');

    await page.getByRole('link', { name: 'Record delivery' }).click();
    await page.getByLabel('Supplier invoice no').fill('SUP-552');
    await page.getByLabel('Add a product').fill('Phone X');
    await page
      .getByRole('button', { name: /Phone X/ })
      .first()
      .click();
    await expect(page.getByTestId('delivery-line-count')).toHaveText('1 item');
    await page.getByLabel('Qty').first().fill('5');
    await expect(
      page.getByTestId('delivery-line-qty').getByLabel('Qty'),
    ).toHaveValue('5');
    const qtyBox = await page
      .getByTestId('delivery-line-qty')
      .getByLabel('Qty')
      .boundingBox();
    expect(qtyBox?.width ?? 0).toBeGreaterThan(45);
    await page.getByLabel('Unit cost').first().fill('1200');
    await page.getByLabel('Paid now').fill('5500');
    await page.getByRole('button', { name: 'Cash' }).click();
    await page.getByRole('button', { name: 'Save delivery' }).click();

    // AC 5: the saved-delivery toast opens the label dialog with received copies.
    await page.getByRole('button', { name: 'Print labels' }).click();
    const labels = page.getByRole('dialog', { name: 'Print labels' });
    await expect(labels).toBeVisible();
    await expect(labels.getByLabel('Copies Phone X')).toHaveValue('5');
    await labels.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByTestId('supplier-balance')).toContainText(
      'You owe Rs 500',
    );
    const [product] = await idbAll<{
      id: string;
      avg_cost: number;
      last_cost: number;
    }>(page, 'products');
    expect(product).toMatchObject({
      avg_cost: 112000,
      last_cost: 120000,
    });
    expect(product?.id).toBe(productId);
    const levels = await idbAll<{ product_id: string; on_hand_milli: number }>(
      page,
      'stock_levels',
    );
    expect(levels.find((l) => l.product_id === productId)?.on_hand_milli).toBe(
      25000,
    );
    const [purchase] = await idbAll<{
      total: number;
      paid_now: number;
      line_count: number;
    }>(page, 'purchases');
    expect(purchase).toMatchObject({
      total: 600000,
      paid_now: 550000,
      line_count: 1,
    });
    const payments = await idbAll<{
      purpose: string;
      amount: number;
      method: string;
    }>(page, 'payments');
    expect(
      payments.find((p) => p.purpose === 'purchase_paid_now'),
    ).toMatchObject({
      amount: 550000,
      method: 'cash',
    });

    await page.getByRole('button', { name: 'Pay supplier' }).click();
    const pay = page.getByRole('dialog', { name: 'Pay supplier' });
    await expect(pay.getByLabel('Amount')).toHaveValue('500');
    await pay.getByRole('button', { name: 'Save payment' }).click();
    await expect(pay).toHaveCount(0);
    await expect(page.getByTestId('supplier-balance')).toContainText('Settled');
    const payments2 = await idbAll<{ purpose: string; amount: number }>(
      page,
      'payments',
    );
    expect(
      payments2.filter((p) => p.purpose === 'supplier_payment'),
    ).toMatchObject([{ amount: 50000 }]);

    await page.getByRole('link', { name: 'Return to supplier' }).click();
    await expect(
      page.getByRole('heading', { name: 'Return to supplier' }),
    ).toBeVisible();
    await page.getByLabel('Linked delivery').selectOption({ index: 1 });
    await page.getByLabel('Return qty Phone X').fill('2');
    await expect(page.getByText('Total credit')).toBeVisible();
    await expect(page.getByText('Rs 2,400').first()).toBeVisible();
    await expect(
      page.getByText(/The supplier owes you Rs 2,400/),
    ).toBeVisible();
    await expect(page.getByLabel('Money received now')).toHaveValue('2400');
    await page.getByRole('button', { name: 'Save return' }).click();
    await expect(page.getByTestId('supplier-balance')).toContainText('Settled');
    const returns = await idbAll<{ total: number; refund_received: number }>(
      page,
      'supplier_returns',
    );
    expect(returns).toMatchObject([{ total: 240000, refund_received: 240000 }]);
    const returnLines = await idbAll<{
      qty_milli: number;
      unit_credit: number;
    }>(page, 'supplier_return_lines');
    expect(returnLines).toMatchObject([
      { qty_milli: 2000, unit_credit: 120000 },
    ]);
    const refunds = await idbAll<{ purpose: string; amount: number }>(
      page,
      'payments',
    );
    expect(
      refunds.filter((p) => p.purpose === 'supplier_refund'),
    ).toMatchObject([{ amount: 240000 }]);
    const levelsAfter = await idbAll<{
      product_id: string;
      on_hand_milli: number;
    }>(page, 'stock_levels');
    expect(
      levelsAfter.find((l) => l.product_id === productId)?.on_hand_milli,
    ).toBe(23000);

    await page
      .getByTestId('suppliers-detail')
      .getByRole('button', { name: 'Export', exact: true })
      .click();
    const [statementPdf] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'PDF' }).click(),
    ]);
    const statementPdfBytes = await readFile((await statementPdf.path()) ?? '');
    expect(statementPdfBytes.subarray(0, 8).toString('latin1')).toBe(
      '%PDF-1.4',
    );
    await page
      .getByTestId('suppliers-detail')
      .getByRole('button', { name: 'Export', exact: true })
      .click();
    const [statementCsv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'CSV' }).click(),
    ]);
    const statementText = await readFile(
      (await statementCsv.path()) ?? '',
      'utf8',
    );
    expect(statementText).toContain('date,description,got,paid,balance');

    await page.getByRole('link', { name: 'Back to suppliers' }).click();
    await expect(page.getByText('Total you owe suppliers')).toBeVisible();
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const text = await readFile((await csv.path()) ?? '', 'utf8');
    expect(text).toContain('name,phone,balance,last_delivery');
    expect(text).toContain('Hall Road Traders');
  });

  test('a delivery with freight allocates it to the lines', async ({
    page,
  }) => {
    await openSuppliers(page);
    await page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'A', price: 300000, cost: 100000, stock: 10 },
        { name: 'B', price: 300000, cost: 100000, stock: 10 },
      ]),
    );
    await newSupplier(page, 'Freight Co');
    await page.getByRole('link', { name: /Freight Co/ }).click();
    await page.getByRole('link', { name: 'Record delivery' }).click();
    for (const name of ['A', 'B']) {
      await page.getByLabel('Add a product').fill(name);
      await page
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .first()
        .click();
    }
    await page.getByLabel('Qty').nth(0).fill('6');
    await page.getByLabel('Qty').nth(1).fill('3');
    await page.getByLabel('Unit cost').nth(0).fill('1000');
    await page.getByLabel('Unit cost').nth(1).fill('1000');
    await page
      .getByLabel("Other charges (on the supplier's invoice)")
      .fill('300');
    await page.getByRole('button', { name: 'Save delivery' }).click();
    await expect(page.getByTestId('supplier-balance')).toContainText(
      'You owe Rs 9,300',
    );
    const lines = await idbAll<{
      charges_alloc: number;
      landed_unit_cost: number;
    }>(page, 'purchase_lines');
    expect(lines.map((l) => l.charges_alloc).sort((a, b) => a - b)).toEqual([
      10000, 20000,
    ]);
    expect(lines.every((l) => l.landed_unit_cost === 103333)).toBe(true);
  });

  test('Urdu: supplier list and new supplier dialog', async ({ page }) => {
    await openSuppliers(page);
    await page.getByLabel('Language').selectOption('ur');
    await expect(page.getByRole('heading', { name: 'سپلائر' })).toBeVisible();
    await page
      .getByRole('button', { name: /نیا سپلائر/ })
      .first()
      .click();
    await expect(
      page.getByRole('dialog', { name: 'نیا سپلائر' }),
    ).toBeVisible();
  });
});
