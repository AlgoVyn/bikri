import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { idbAll, openReadyShop } from './helpers.ts';

// T-043/T-044: customers, statement, payments, reminders, promises and chase (screens/12).

async function seedAli(page: Page, phone = '03001234567') {
  return (await page.evaluate(
    (p) =>
      window.__bikriTest?.seedCustomer({
        name: 'Ali',
        phone: p,
        limit: 1000000,
        balance: 300000,
      }),
    phone,
  )) as string;
}

const dialog = (page: Page, name: string | RegExp) =>
  page.getByRole('dialog', { name });

async function openAli(page: Page, id: string) {
  await page.goto(`/bikri/udhaar/${id}`);
  await expect(page.getByTestId('statement-balance')).toBeVisible();
}

async function addPromise(page: Page, amount: string) {
  await page.getByRole('button', { name: 'Add promise' }).click();
  const d = dialog(page, 'Add promise');
  const today = await d.getByLabel('Date').inputValue();
  const next = new Date(`${today}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  await d.getByLabel('Date').fill(next.toISOString().slice(0, 10));
  await d.getByLabel('Amount (optional)').fill(amount);
  await d.getByRole('button', { name: 'Save promise' }).click();
  await expect(d).toHaveCount(0);
}

async function receive(page: Page, amount: string) {
  await page.getByRole('button', { name: 'Receive money' }).click();
  const d = dialog(page, 'Receive money');
  await d.getByLabel('Amount').fill(amount);
  await d.getByRole('button', { name: 'Save payment' }).click();
  await expect(d).toHaveCount(0);
}

async function captureOpen(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __opened: string | null }).__opened = null;
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string | null }).__opened = String(url);
      return null;
    }) as typeof window.open;
  });
}

async function opened(page: Page): Promise<string> {
  await page.waitForFunction(
    () => (window as unknown as { __opened?: string | null }).__opened !== null,
  );
  return page.evaluate(
    () => (window as unknown as { __opened: string }).__opened,
  );
}

test.describe('Udhaar (T-043, T-044)', () => {
  test('AC 1, 2, 4, 5, 7: statement 3,000 → 890, reminder URL, promise kept, chase total and offline exports', async ({
    page,
    context,
  }) => {
    await openReadyShop(page, '/bikri/udhaar');
    const ali = await seedAli(page);
    await expect(page.getByTestId('udhaar-total')).toContainText('Rs 3,000');
    await expect(page.getByTestId('udhaar-owing')).toContainText('1');

    await page.getByRole('link', { name: /Ali/ }).click();
    await expect(page.getByTestId('statement-balance')).toContainText(
      'Owes Rs 3,000',
    );
    await addPromise(page, '2000');
    await receive(page, '2110');
    await expect(page.getByTestId('statement-balance')).toContainText(
      'Owes Rs 890',
    );

    const promises = await idbAll<{ status: string }>(page, 'promises');
    expect(promises).toMatchObject([{ status: 'kept' }]);
    const [payment] = await idbAll<{ amount: number; purpose: string }>(
      page,
      'payments',
    );
    expect(payment).toMatchObject({
      amount: 211000,
      purpose: 'customer_payment',
    });

    await captureOpen(page);
    await page.getByRole('button', { name: 'Send reminder' }).click();
    const url = await opened(page);
    expect(url).toContain('https://wa.me/923001234567?text=');
    expect(url).toContain('Assalam-o-Alaikum%20Ali%2C');
    expect(url).toContain('Rs%20890');

    // Statement PDF works offline (AC 7).
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Export' }).click();
    const [pdf] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'PDF' }).click(),
    ]);
    const bytes = await readFile((await pdf.path()) ?? '');
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    await context.setOffline(false);

    // Statement CSV has the documented header (AC 7).
    await page.getByRole('button', { name: 'Export' }).click();
    const [statementCsv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'CSV' }).click(),
    ]);
    const statementText = await readFile(
      (await statementCsv.path()) ?? '',
      'utf8',
    );
    expect(statementText).toContain('date,description,debit,credit,balance');

    await page.getByRole('link', { name: 'Back to customers' }).click();
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const text = await readFile((await csv.path()) ?? '', 'utf8');
    expect(text).toContain(
      'name,phone,balance,oldest_unpaid_days,credit_limit,promise_on,last_activity',
    );
    expect(text).toContain('Ali');

    await page.getByRole('link', { name: 'Chase list' }).click();
    await expect(page.getByRole('heading', { name: '0–7 days' })).toBeVisible();
    await expect(page.getByText('Total owed to you:')).toBeVisible();
    await expect(page.getByTestId('chase-total')).toContainText('Rs 890');
    expect(ali).toBeTruthy();
  });

  test('AC 2/3/6: new customer with a limit and opening balance; no phone disables the reminder', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/udhaar');
    await page.getByRole('button', { name: 'New customer' }).first().click();
    const d = dialog(page, 'New customer');
    await d.getByLabel('Name').fill('Sana');
    await d.getByLabel('Credit limit').fill('1000');
    await d.getByLabel('Opening balance').fill('500');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Sana/ })).toContainText(
      'Owes Rs 500',
    );
    const customers = await idbAll<{
      name: string;
      credit_limit: number;
      phone: string;
    }>(page, 'customers');
    expect(customers.find((c) => c.name === 'Sana')).toMatchObject({
      credit_limit: 100000,
      phone: '',
    });
    const opening = await idbAll<{ source_type: string; amount: number }>(
      page,
      'ledger_entries',
    );
    expect(opening).toMatchObject([{ source_type: 'opening', amount: 50000 }]);

    await page.getByRole('link', { name: /Sana/ }).click();
    await expect(
      page.getByRole('button', { name: 'Send reminder' }),
    ).toBeDisabled();
  });

  test('Urdu statement and reminder', async ({ page }) => {
    await openReadyShop(page, '/bikri/udhaar');
    const ali = await seedAli(page);
    await page.getByLabel('Language').selectOption('ur');
    await openAli(page, ali as string);
    await expect(page.getByTestId('statement-balance')).toContainText('بقایا');
    await expect(
      page.getByRole('columnheader', { name: 'تفصیل' }),
    ).toBeVisible();
    await captureOpen(page);
    await page.getByRole('button', { name: 'یاد دہانی بھیجیں' }).click();
    const url = await opened(page);
    expect(url.startsWith('https://wa.me/923001234567?text=%D8%A7')).toBe(true);
  });
});
