import { expect, type Page, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  idbAll,
  openReadyShop,
  setLanguage,
} from './helpers.ts';
import {
  API,
  createShop,
  enrol,
  newTill,
  ORIGIN,
  syncNow,
  unlock,
} from './syncHelpers.ts';

// v1.1 bundles: management (journey 27) and sale/whole-bundle refund (journey 26)
// (docs/10-testing.md §5, screens/05, 08 and 11). Every scenario runs in English and
// Urdu; Playwright repeats it at 1280×800 and 390×844.

type Row = Record<string, unknown>;
type Locale = 'en' | 'ur';

const LOCALES: Locale[] = ['en', 'ur'];
const BUNDLE = 'Starter Pack';
const BUNDLE_UR = 'اسٹارٹر پیک';
const BUNDLE_PRICE_RUPEES = 56_500;
const BUNDLE_PRICE = BUNDLE_PRICE_RUPEES * 100;
const EDIT_PRICE = 5_500_000;
const CABLE_PRICE = 149_900;

const COMPONENTS = [
  {
    name: 'Galaxy A15',
    name_ur: 'گلیکسی اے 15',
    sku: 'PHONE-A15',
    price: 5_299_000,
    cost: 4_500_000,
    stock: 3,
  },
  {
    name: 'Charger 25 W',
    name_ur: 'چارجر 25 واٹ',
    sku: 'CHG-25W',
    price: 299_900,
    cost: 200_000,
    stock: 10,
  },
  {
    name: 'Clear cover',
    name_ur: 'شفاف کور',
    sku: 'COV-CLR',
    price: 149_900,
    cost: 90_000,
    stock: 10,
  },
  {
    name: 'Screen protector',
    name_ur: 'اسکرین پروٹیکٹر',
    sku: 'GLS-TMP',
    price: 49_900,
    cost: 30_000,
    stock: 10,
  },
] as const;
const bundleName = (locale: Locale) => (locale === 'ur' ? BUNDLE_UR : BUNDLE);

const header = { origin: ORIGIN };

/** The real product form, in the active language (ids end in the field key). */
async function createBundle(page: Page): Promise<string> {
  await page.evaluate(() => window.__bikriTest?.navigate('/products/new'));
  await page.locator('input[id$="-name_en"]').fill(BUNDLE);
  await page.locator('input[id$="-name_ur"]').fill(BUNDLE_UR);
  await page.locator('input[id$="-kind"]').check();
  await page.locator('input[id$="-price"]').fill(String(BUNDLE_PRICE_RUPEES));
  for (const component of COMPONENTS) {
    await page.locator('#bundle-add-search').fill(component.sku);
    await page
      .locator('#bundle-add-search + ul button')
      .filter({ hasText: component.sku })
      .click();
  }
  await page.locator('form button[type=submit]').click();
  await expect(page.getByRole('heading', { name: BUNDLE })).toBeVisible();
  return page.url().split('/').at(-1) ?? '';
}

async function seedComponents(page: Page): Promise<string[]> {
  return (
    (await page.evaluate(
      (list) => window.__bikriTest?.seedProducts(list),
      COMPONENTS.map((component) => ({
        name: component.name,
        name_ur: component.name_ur,
        sku: component.sku,
        price: component.price,
        cost: component.cost,
        stock: component.stock,
      })),
    )) ?? []
  );
}

async function openLocale(
  page: Page,
  locale: Locale,
  path = '/bikri/products',
) {
  await openReadyShop(page, path);
  if (locale === 'ur') await setLanguage(page, locale);
}

async function sellTiles(page: Page, locale: Locale): Promise<void> {
  await page
    .getByTestId('sell-tile')
    .filter({ hasText: bundleName(locale) })
    .click();
  await page.getByTestId('sell-tile').filter({ hasText: 'Cable' }).click();
}

async function showCart(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 1024)
    await page.getByTestId('cart-bar').click();
}

async function takePayment(page: Page): Promise<void> {
  await page.keyboard.press('F8');
  const pay = page.getByRole('dialog');
  await expect(pay.getByTestId('pay-done')).toBeVisible();
  await pay.getByTestId('pay-done').click();
  await expect(page.getByTestId('sale-saved')).toBeVisible();
}

async function printReceipt(page: Page): Promise<string> {
  await page.getByRole('button', { name: /Print again|دوبارہ پرنٹ/u }).click();
  await expect
    .poll(async () => (await idbAll<Row>(page, 'print_jobs')).length)
    .toBeGreaterThan(0);
  const jobs = await idbAll<Row>(page, 'print_jobs');
  const job = jobs.at(-1);
  expect(job).toBeTruthy();
  return (
    (await page.evaluate(
      (id) => window.__bikriTest?.printJobText(String(id)),
      String(job?.id),
    )) ?? ''
  );
}

async function reprintBill(page: Page, saleId: string): Promise<string> {
  const before = (await idbAll<Row>(page, 'print_jobs')).length;
  await page.evaluate(
    (id) => window.__bikriTest?.navigate(`/sales/${id}`),
    saleId,
  );
  const button = page.getByRole('button', { name: /^(Print|پرنٹ)$/u }).first();
  await expect(button).toBeVisible();
  await button.click();
  await expect
    .poll(async () => (await idbAll<Row>(page, 'print_jobs')).length)
    .toBeGreaterThan(before);
  const job = (await idbAll<Row>(page, 'print_jobs')).at(-1);
  return (
    (await page.evaluate(
      (id) => window.__bikriTest?.printJobText(String(id)),
      String(job?.id),
    )) ?? ''
  );
}

async function serverRows(
  request: import('@playwright/test').APIRequestContext,
  tenantId: string,
  tbl: string,
): Promise<number> {
  const before = Date.now();
  let after = '';
  let rows = 0;
  for (;;) {
    const query = new URLSearchParams({ tbl, before: String(before), after });
    const res = await request.get(
      `${API}/admin/tenants/${tenantId}/export?${query.toString()}`,
      { headers: header },
    );
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as {
      rows: unknown[];
      next_after: string;
      has_more: boolean;
    };
    rows += body.rows.length;
    if (!body.has_more) return rows;
    after = body.next_after;
  }
}

test.describe('Bundles (journeys 26–27)', () => {
  test('journey 27: create, derived figures, delete guard and delete', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    for (const locale of LOCALES) {
      await openLocale(page, locale);
      const [phoneId] = await seedComponents(page);
      const bundleId = await createBundle(page);

      const detail = page.getByTestId('products-detail');
      await expect(detail.getByTestId('detail-items-total')).toContainText(
        '57,987',
      );
      await expect(detail.getByTestId('detail-bundle-saves')).toContainText(
        '1,487',
      );
      await expect(detail.getByTestId('detail-avg-cost')).toContainText(
        '48,200',
      );
      await expect(detail.getByTestId('detail-on-hand')).toContainText('3');
      const recipe = detail.getByTestId('bundle-recipe');
      for (const component of COMPONENTS)
        await expect(recipe).toContainText(component.name);
      const pill = locale === 'ur' ? 'بنڈل' : 'Bundle';
      await expect(
        detail.getByText(pill, { exact: true }).first(),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);

      // A component used by an active bundle cannot be deleted.
      await page.evaluate(
        (id) => window.__bikriTest?.navigate(`/products/${id}`),
        phoneId,
      );
      await page
        .getByTestId('product-actions')
        .getByTestId('page-actions-more')
        .click();
      await page
        .getByTestId('product-actions')
        .getByRole('toolbar')
        .getByRole('button')
        .last()
        .click();
      await page.getByRole('dialog').locator('button').last().click();
      const blocked = page.getByRole('alert');
      await expect(blocked).toContainText(BUNDLE);
      const products = await idbAll<Row>(page, 'products');
      expect(
        products.find((product) => product.id === phoneId)?.deleted_at,
      ).toBeNull();

      // Deleting the bundle is allowed; history is untouched.
      await page.evaluate(
        (id) => window.__bikriTest?.navigate(`/products/${id}`),
        bundleId,
      );
      await page
        .getByTestId('product-actions')
        .getByTestId('page-actions-more')
        .click();
      await page
        .getByTestId('product-actions')
        .getByRole('toolbar')
        .getByRole('button')
        .last()
        .click();
      await page.getByRole('dialog').locator('button').last().click();
      await expect(page).toHaveURL(/\/bikri\/products$/u);
      const after = await idbAll<Row>(page, 'products');
      expect(
        after.find((product) => product.id === bundleId)?.deleted_at,
      ).toEqual(expect.any(Number));
    }
  });

  test('journey 27: editing a bundle price updates new carts and leaves the saved bill unchanged', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    for (const locale of LOCALES) {
      await openLocale(page, locale);
      await seedComponents(page);
      const bundleId = await createBundle(page);
      await page.evaluate(
        (price) =>
          window.__bikriTest?.seedProducts([
            { name: 'Cable 1 m', price, cost: 900, stock: 20 },
            {
              name: 'SIM tool',
              sku: 'SIM-TOOL',
              price: 9_900,
              cost: 1_000,
              stock: 5,
            },
          ]),
        CABLE_PRICE,
      );
      await page.evaluate(() => window.__bikriTest?.navigate('/sell'));
      await sellTiles(page, locale);
      await takePayment(page);
      const saleId = String(
        (await idbAll<Row>(page, 'sales')).at(-1)?.id ?? '',
      );

      // Edit the price and add a component: the detail and new carts use both, the
      // saved bill and its reprint keep the recipe and price they were sold with.
      await page.goto(`/bikri/products/${bundleId}/edit`);
      await page.locator('input[id$="-price"]').fill('55000');
      await page.locator('#bundle-add-search').fill('SIM-TOOL');
      await page
        .locator('#bundle-add-search + ul button')
        .filter({ hasText: 'SIM-TOOL' })
        .click();
      await page.keyboard.press('Control+s');
      const detail = page.getByTestId('products-detail');
      await expect(detail.getByTestId('detail-bundle-saves')).toContainText(
        '3,086',
      );
      await expect(detail.getByTestId('bundle-recipe')).toContainText(
        'SIM tool',
      );
      await page.evaluate(() => window.__bikriTest?.navigate('/sell'));
      await expect(
        page.getByTestId('sell-tile').filter({ hasText: bundleName(locale) }),
      ).toContainText('55,000');

      // The saved bill keeps the original component lines and price.
      const saved = (await idbAll<Row>(page, 'sale_lines')).filter(
        (line) => line.sale_id === saleId,
      );
      expect(saved).toHaveLength(5);
      for (const line of saved.filter((row) => row.bundle_id === bundleId))
        expect(line.bundle_price).toBe(BUNDLE_PRICE);
      expect(saved.some((line) => line.bundle_price === EDIT_PRICE)).toBe(
        false,
      );
      expect(saved.some((line) => line.name_snapshot === 'SIM tool')).toBe(
        false,
      );
      const reprinted = await reprintBill(page, saleId);
      expect(reprinted).toContain(BUNDLE);
      for (const component of COMPONENTS)
        expect(reprinted).toContain(component.name);
      expect(reprinted).not.toContain('SIM tool');
      expect(reprinted).toContain('56,500');
    }
  });

  test('journey 26: bundle sale, receipt, whole-bundle refund and saved-bill snapshot', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    for (const locale of LOCALES) {
      await openLocale(page, locale, '/bikri/sell');
      const componentIds = await seedComponents(page);
      await page.evaluate(
        (price) =>
          window.__bikriTest?.seedProducts([
            {
              name: 'Cable 1 m',
              price,
              cost: 900,
              stock: 20,
              sku: 'CBL-1M',
            },
          ]),
        CABLE_PRICE,
      );
      const bundleId = await createBundle(page);
      await page.evaluate(() => window.__bikriTest?.navigate('/sell'));

      await sellTiles(page, locale);
      await showCart(page);
      const group = page.getByTestId('bundle-group');
      await expect(group).toBeVisible();
      await expect(group).toContainText(BUNDLE);
      // One bundle group is one row with four component quantities, not four rows.
      const groupHeader = group.getByRole('button').first();
      if ((await groupHeader.getAttribute('aria-expanded')) !== 'true')
        await groupHeader.click();
      await expect(group.getByTestId('bundle-component')).toHaveCount(4);
      // Asking for more than the recipe can make shows the amber warning, not a block.
      await group.locator('input[inputmode="numeric"]').fill('4');
      await page.keyboard.press('Enter');
      await expect(group.getByTestId('badge-stock')).toBeVisible();
      await group.locator('input[inputmode="numeric"]').fill('2');
      await page.keyboard.press('Enter');
      await expect(group.getByTestId('line-total')).toContainText('113,000');

      await takePayment(page);
      const receipt = await printReceipt(page);
      expect(receipt).toContain(BUNDLE);
      for (const component of COMPONENTS)
        expect(receipt).toContain(component.name);
      expect(receipt).not.toContain('52,990');
      expect(receipt).toContain('113,000');

      const sales = await idbAll<Row>(page, 'sales');
      const saleId = String(sales.at(-1)?.id ?? '');
      const lines = (await idbAll<Row>(page, 'sale_lines')).filter(
        (line) => line.sale_id === saleId,
      );
      expect(lines).toHaveLength(5);
      const bundleLines = lines.filter((line) => line.bundle_id === bundleId);
      expect(bundleLines).toHaveLength(4);
      const groups = new Set(bundleLines.map((line) => line.bundle_group));
      expect(groups.size).toBe(1);
      for (const line of bundleLines) {
        expect(line.bundle_qty).toBe(2);
        expect(line.bundle_component_qty_milli).toBe(1000);
        expect(line.qty_milli).toBe(2000);
        expect(line.bundle_price).toBe(BUNDLE_PRICE);
      }
      const saleMoves = (await idbAll<Row>(page, 'stock_movements')).filter(
        (move) =>
          move.reason_code === 'sale' &&
          move.ref_id === saleId &&
          componentIds.includes(String(move.product_id)),
      );
      expect(saleMoves).toHaveLength(4);
      for (const move of saleMoves) expect(move.qty_delta_milli).toBe(-2000);
      const levelsAfterSale = new Map(
        (await idbAll<Row>(page, 'stock_levels')).map((level) => [
          String(level.product_id),
          Number(level.on_hand_milli),
        ]),
      );
      for (const [index, id] of componentIds.entries())
        expect(levelsAfterSale.get(id), COMPONENTS[index]?.name).toBe(
          (COMPONENTS[index]?.stock ?? 0) * 1000 - 2000,
        );

      // The sale snapshot keeps the bundle price it was sold at.
      const saved = (await idbAll<Row>(page, 'sale_lines')).filter(
        (line) => line.sale_id === saleId && line.bundle_id === bundleId,
      );
      for (const line of saved) expect(line.bundle_price).toBe(BUNDLE_PRICE);

      // Whole-bundle return: one bundle row, all four component lines restocked.
      const refund = async () => {
        await page.evaluate(
          (id) => window.__bikriTest?.navigate(`/sales/${id}`),
          saleId,
        );
        await page.evaluate(
          (id) => window.__bikriTest?.navigate(`/sales/${id}/refund`),
          saleId,
        );
        const dialog = page.getByRole('dialog');
        const bundleRow = dialog.getByTestId('refund-bundle');
        await expect(bundleRow).toBeVisible();
        await bundleRow.getByRole('checkbox').first().check();
        // One of the two sold bundles: the stepper defaults to all remaining.
        await bundleRow.locator('input[inputmode="numeric"]').fill('1');
        // The reason fieldset is the second one (type, reason, method).
        await dialog
          .locator('fieldset')
          .nth(1)
          .getByRole('button')
          .first()
          .click();
        await dialog.locator('button').last().click();
        await expect(page.getByTestId('refund-saved')).toBeVisible();
      };

      await refund();
      let refunds = await idbAll<Row>(page, 'refunds');
      expect(refunds).toHaveLength(1);
      let refundLines = await idbAll<Row>(page, 'refund_lines');
      expect(refundLines).toHaveLength(4);
      for (const line of refundLines) expect(line.qty_milli).toBe(1000);
      const restocked = (await idbAll<Row>(page, 'stock_movements')).filter(
        (move) => move.reason_code === 'refund_return',
      );
      expect(restocked).toHaveLength(4);
      for (const move of restocked) expect(move.qty_delta_milli).toBe(1000);

      // The second refund returns the remaining bundle and marks the bill refunded.
      await refund();
      refunds = await idbAll<Row>(page, 'refunds');
      expect(refunds).toHaveLength(2);
      refundLines = await idbAll<Row>(page, 'refund_lines');
      expect(refundLines).toHaveLength(8);
      await page.evaluate(
        (id) => window.__bikriTest?.navigate(`/sales/${id}`),
        saleId,
      );
      await expect(page.getByTestId('bill-status')).toHaveText(
        locale === 'ur' ? 'کچھ رقم واپس' : 'Part refunded',
      );
      const levelsAfterRefunds = new Map(
        (await idbAll<Row>(page, 'stock_levels')).map((level) => [
          String(level.product_id),
          Number(level.on_hand_milli),
        ]),
      );
      for (const [index, id] of componentIds.entries())
        expect(levelsAfterRefunds.get(id), COMPONENTS[index]?.name).toBe(
          (COMPONENTS[index]?.stock ?? 0) * 1000,
        );
      await expectNoHorizontalScroll(page);
    }
  });
});

test('journey 26: an offline bundle sale and whole-bundle refund sync afterwards', async ({
  browser,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'sync is viewport-independent',
  );
  test.setTimeout(150_000);
  const shop = await createShop(request, `bundle-${Date.now()}@e2e.test`);
  const till = await newTill(browser);
  await enrol(till.page, shop.owner_code.code, 'Counter 1');
  await till.page.waitForFunction(() => window.__bikriTest !== undefined);
  await till.page.evaluate(() => window.__bikriTest?.finishSetupHere());
  await till.page.evaluate(() => window.__bikriTest?.navigate('/'));
  await unlock(till.page);
  await seedComponents(till.page);
  await till.page.evaluate(
    (price) =>
      window.__bikriTest?.seedProducts([
        { name: 'Cable 1 m', price, cost: 900, stock: 20 },
      ]),
    CABLE_PRICE,
  );
  await createBundle(till.page);
  await syncNow(till.page);
  await expect(till.page.getByTestId('staff-menu')).toHaveAttribute(
    'data-sync-state',
    'synced',
    { timeout: 30_000 },
  );
  // Warm the lazy route tree while online; the offline sale/refund is the subject of
  // this test, not cold-loading the router chunk.
  await till.page.evaluate(() => window.__bikriTest?.navigate('/sales'));
  await expect(till.page.getByTestId('staff-menu')).toBeVisible();
  await till.page.evaluate(() => window.__bikriTest?.navigate('/'));

  // The first offline navigation needs the lazy route chunk; wait for the worker to
  // finish precaching, reload so this page is controlled, and unlock again.
  await till.page.evaluate(
    async () => (await navigator.serviceWorker.ready).active?.state,
  );
  await till.page.reload();
  await unlock(till.page);
  await till.ctx.setOffline(true);
  await till.page.evaluate(() => window.__bikriTest?.navigate('/sell'));
  await sellTiles(till.page, 'en');
  await takePayment(till.page);
  const sale = (await idbAll<Row>(till.page, 'sales')).at(-1);
  expect(sale?.id).toBeTruthy();

  await till.page.evaluate(
    (id) => window.__bikriTest?.navigate(`/sales/${id}/refund`),
    String(sale?.id),
  );
  const dialog = till.page.getByRole('dialog');
  await dialog
    .getByTestId('refund-bundle')
    .getByRole('checkbox')
    .first()
    .check();
  await dialog.locator('fieldset').nth(1).getByRole('button').first().click();
  await dialog.locator('button').last().click();
  await expect(till.page.getByTestId('refund-saved')).toBeVisible();

  await till.ctx.setOffline(false);
  await syncNow(till.page);
  await expect(till.page.getByTestId('staff-menu')).toHaveAttribute(
    'data-sync-state',
    'synced',
    { timeout: 30_000 },
  );
  expect(await serverRows(request, shop.tenant.id, 'sales')).toBe(1);
  expect(await serverRows(request, shop.tenant.id, 'sale_lines')).toBe(5);
  expect(await serverRows(request, shop.tenant.id, 'refunds')).toBe(1);
  expect(await serverRows(request, shop.tenant.id, 'refund_lines')).toBe(4);
  await till.ctx.close();
});
