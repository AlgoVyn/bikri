import { expect, test } from '@playwright/test';
import { openReadyShop } from './helpers.ts';

type Align = 'start' | 'end';

async function expectAligned(
  page: import('@playwright/test').Page,
  headerSelector: string,
  rowSelector: string,
  align: readonly Align[],
  skipHeaderCells = 0,
) {
  const boxes = await page.evaluate(
    ({ headerSelector, rowSelector, skipHeaderCells }) => {
      const header = document.querySelector(headerSelector);
      const row = document.querySelector(rowSelector);
      if (!header || !row) return null;
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, right: box.x + box.width };
      };
      return {
        header: [...header.children].slice(skipHeaderCells).map(rect),
        row: [...row.children].slice(skipHeaderCells).map(rect),
      };
    },
    { headerSelector, rowSelector, skipHeaderCells },
  );
  expect(boxes).not.toBeNull();
  expect(boxes?.header.length).toBe(align.length);
  expect(boxes?.row.length).toBe(align.length);
  for (let index = 0; index < align.length; index += 1) {
    const header = boxes?.header[index];
    const row = boxes?.row[index];
    if (!header || !row) continue;
    if (align[index] === 'start')
      expect(Math.abs(header.x - row.x)).toBeLessThanOrEqual(2);
    else expect(Math.abs(header.right - row.right)).toBeLessThanOrEqual(2);
  }
}

test.describe('list header alignment', () => {
  test('headers follow the column justification on every main list', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop columns');
    await openReadyShop(page, '/bikri/products');
    await page.evaluate(async () => {
      const hooks = window.__bikriTest;
      if (!hooks) throw new Error('test hooks missing');
      await hooks.seedProducts([
        { name: 'Alignment product', price: 100000, stock: 5 },
      ]);
      await hooks.seedTodaySales();
      await hooks.seedCustomer({
        name: 'Alignment customer',
        phone: '+923001112233',
        balance: 125000,
      });
      await hooks.seedSupplier({
        name: 'Alignment supplier',
        phone: '+924235761234',
        opening: 850000,
      });
    });

    await page.evaluate(() => window.__bikriTest?.navigate('/products'));
    await expect(page.getByTestId('products-list-header')).toBeVisible();
    await expectAligned(
      page,
      '[data-testid="products-list-header"]',
      'ul[aria-label="Products"] > li a',
      ['start', 'start', 'end', 'end', 'end', 'end', 'end'],
      1,
    );

    await page.evaluate(() => window.__bikriTest?.navigate('/sales'));
    await expect(page.getByTestId('sales-list-header')).toBeVisible();
    await expectAligned(
      page,
      '[data-testid="sales-list-header"]',
      '[data-testid="sales-list-header"] ~ li a',
      ['start', 'start', 'start', 'end', 'end', 'start', 'end'],
    );

    await page.evaluate(() => window.__bikriTest?.navigate('/udhaar'));
    await expect(page.getByTestId('udhaar-list-header')).toBeVisible();
    await expectAligned(
      page,
      '[data-testid="udhaar-list-header"]',
      '[data-testid="udhaar-list-header"] ~ li a',
      ['start', 'end', 'start', 'start', 'start'],
    );

    await page.evaluate(() => window.__bikriTest?.navigate('/suppliers'));
    await expect(page.getByTestId('suppliers-list-header')).toBeVisible();
    await expectAligned(
      page,
      '[data-testid="suppliers-list-header"]',
      '[data-testid="suppliers-list-header"] ~ li a',
      ['start', 'end', 'start'],
    );
  });
});
