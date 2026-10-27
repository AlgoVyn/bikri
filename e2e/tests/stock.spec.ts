import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalScroll, idbAll, openReadyShop } from './helpers.ts';

// T-021: stock adjust and stock count (screens/09 ACs 1–3, 5).

type Movement = {
  product_id: string;
  reason_code: string;
  qty_delta_milli: number;
  unit_cost: number | null;
};

async function shop(page: Page) {
  await openReadyShop(page, '/bikri/products');
  return page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      {
        name: 'Cable',
        price: 150000,
        cost: 110000,
        stock: 12,
        barcode: '8901111111111',
      },
      {
        name: 'Charger',
        price: 150000,
        cost: 110000,
        stock: 20,
        barcode: '8902222222222',
      },
    ]),
  ) as Promise<string[]>;
}

const go = (page: Page, to: string) =>
  page.evaluate((p) => window.__bikriTest?.navigate(p), to);
const dialog = (page: Page) => page.getByRole('dialog');
const moves = async (page: Page, reason: string) =>
  (await idbAll<Movement>(page, 'stock_movements')).filter(
    (m) => m.reason_code === reason,
  );

test.describe('Stock adjust (T-021)', () => {
  test('AC 1, 2: stock out 3 Damaged on 12 → 9; count 7 → −2; equal count writes nothing; Lost needs a note', async ({
    page,
  }) => {
    const [cable] = await shop(page);
    await go(page, `/products/${cable}`);
    await page.getByRole('link', { name: 'Adjust stock' }).click();
    await expect(dialog(page)).toContainText('On hand 12 pc');
    await dialog(page).getByRole('tab', { name: 'Stock out' }).click();
    await dialog(page).getByLabel('Reason').selectOption('damaged');
    await dialog(page).getByLabel('Quantity', { exact: true }).fill('3');
    await expect(dialog(page).getByTestId('adjust-new')).toContainText(
      'New on hand: 9 pc',
    );
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('detail-on-hand')).toContainText('9');
    expect(
      (await moves(page, 'damaged')).map((m) => m.qty_delta_milli),
    ).toEqual([-3000]);
    await expect(page).toHaveURL(new RegExp(`/products/${cable}$`, 'u'));

    // Count 7 on 9 → −2000; again 7 → nothing.
    await page.getByRole('link', { name: 'Adjust stock' }).click();
    await dialog(page).getByRole('tab', { name: 'Count' }).click();
    await dialog(page)
      .getByLabel('Counted quantity', { exact: true })
      .fill('7');
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('detail-on-hand')).toContainText('7');
    await page.getByRole('link', { name: 'Adjust stock' }).click();
    await dialog(page).getByRole('tab', { name: 'Count' }).click();
    await dialog(page)
      .getByLabel('Counted quantity', { exact: true })
      .fill('7');
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(
      page.getByText('Count matches on hand — nothing to change.'),
    ).toBeVisible();
    expect((await moves(page, 'count')).map((m) => m.qty_delta_milli)).toEqual([
      -2000,
    ]);

    // Lost needs a note.
    await page.getByRole('link', { name: 'Adjust stock' }).click();
    await dialog(page).getByRole('tab', { name: 'Stock out' }).click();
    await dialog(page).getByLabel('Reason').selectOption('lost');
    await dialog(page).getByLabel('Quantity', { exact: true }).fill('1');
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText(
      'Write a note for this reason (up to 120 characters).',
    );
    await page.keyboard.press('Escape');
    await expectNoHorizontalScroll(page);
  });

  test('AC 3 (C1): stock in 5 Bought locally @ Rs 1,200 on 20 @ Rs 1,100 → avg Rs 1,120', async ({
    page,
  }) => {
    const [, charger] = await shop(page);
    await go(page, `/products/${charger}/adjust`);
    await dialog(page).getByLabel('Reason').selectOption('received_local');
    await expect(dialog(page).getByLabel('Cost per item')).toHaveValue('1100');
    await dialog(page).getByLabel('Cost per item').fill('1200');
    await dialog(page).getByLabel('Quantity', { exact: true }).fill('5');
    await expect(dialog(page).getByTestId('adjust-new')).toContainText(
      'New on hand: 25 pc',
    );
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('detail-avg-cost')).toContainText('Rs 1,120');
    await expect(page.getByTestId('detail-last-cost')).toContainText(
      'Rs 1,200',
    );
    expect(await moves(page, 'received_local')).toMatchObject([
      { qty_delta_milli: 5000, unit_cost: 120000 },
    ]);
  });

  test('AC 5: a cashier sees no Adjust button and the route goes back to the product', async ({
    page,
  }) => {
    const [cable] = await shop(page);
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier', 'Sana'));
    await go(page, `/products/${cable}`);
    await expect(
      page.getByRole('heading', { name: 'Cable', level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Adjust stock' })).toHaveCount(
      0,
    );
    await go(page, `/products/${cable}/adjust`);
    await expect(page).toHaveURL(new RegExp(`/products/${cable}$`, 'u'));
    await expect(dialog(page)).toHaveCount(0);
    await go(page, '/stock/count');
    await expect(page).toHaveURL(/\/bikri\/?$/u);
  });

  test('stock count: scan adds 1, typed counts, draft kept, Finish uses on hand at Finish', async ({
    page,
  }) => {
    const [cable] = await shop(page);
    await page.getByRole('link', { name: 'Stock count' }).click();
    await page.getByRole('button', { name: 'Start count' }).click();
    await expect(page.getByTestId('count-row')).toHaveCount(2);
    const scan = page.getByLabel('Scan to add 1');
    for (let i = 0; i < 2; i += 1) {
      await scan.fill('8901111111111');
      await scan.press('Enter');
    }
    await expect(page.getByLabel('Counted Cable', { exact: true })).toHaveValue(
      '2',
    );
    await page.getByLabel('Counted Charger', { exact: true }).fill('20');
    await page.getByLabel('Counted Charger', { exact: true }).blur();
    await expect(page.getByTestId('count-progress')).toHaveText(
      '2 of 2 counted',
    );
    const kv = await idbAll<{
      key: string;
      value: { counted: Record<string, number> };
    }>(page, 'kv');
    expect(
      kv.find((k) => k.key === 'stock_count_draft')?.value.counted[
        cable as string
      ],
    ).toBe(2000);
    await page.getByRole('button', { name: 'Finish count' }).click();
    await expect(
      page.getByText('Count saved: 1 product changed.'),
    ).toBeVisible();
    expect((await moves(page, 'count')).map((m) => m.qty_delta_milli)).toEqual([
      -10000,
    ]);
    const audit = await idbAll<{ action: string }>(page, 'audit_log');
    expect(audit.filter((a) => a.action === 'stock_count')).toHaveLength(1);
    await expect(
      page.getByRole('button', { name: 'Start count' }),
    ).toBeVisible();
  });

  test('Urdu: adjust dialog', async ({ page }) => {
    const [cable] = await shop(page);
    await page.getByLabel('Language').selectOption('ur');
    await go(page, `/products/${cable}/adjust`);
    await expect(dialog(page)).toContainText('موجود');
    await dialog(page).getByRole('tab', { name: 'اسٹاک گیا' }).click();
    await dialog(page).getByLabel('مقدار', { exact: true }).fill('2');
    await expect(dialog(page).getByTestId('adjust-new')).toContainText('10');
    await dialog(page).getByRole('button', { name: 'محفوظ کریں' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(
      (await moves(page, 'damaged')).map((m) => m.qty_delta_milli),
    ).toEqual([-2000]);
  });
});
