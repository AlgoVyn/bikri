import { expect, type Page, test } from '@playwright/test';
import {
  API,
  createShop,
  enrol,
  newTill,
  ORIGIN,
  syncNow,
  unlock,
} from './syncHelpers.ts';

// Journeys 21 and 22 (10-testing §6): two shops on one server stay apart, a shop over its daily
// sync budget keeps selling locally while the other keeps syncing.
test.describe.configure({ mode: 'serial' });
test.beforeEach(({ browserName: _b }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one viewport is enough');
});

async function setUpTill(
  page: Page,
  code: string,
  product: string,
  price: number,
) {
  await enrol(page, code);
  await page.waitForFunction(() => window.__bikriTest !== undefined);
  await page.evaluate(() => window.__bikriTest?.finishSetupHere());
  await page.goto('/bikri/');
  await unlock(page);
  await page.evaluate(
    ([name, p]) =>
      window.__bikriTest?.seedProducts([
        {
          name: name as string,
          price: p as number,
          barcode: '8901234567890',
          stock: 3,
        },
      ]),
    [product, price] as const,
  );
  await syncNow(page);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    'synced',
  );
}

async function productNames(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open(
          `bikri-${localStorage.getItem('bikri.active_tenant')}`,
        );
        open.onsuccess = () => {
          const req = open.result
            .transaction('products')
            .objectStore('products')
            .getAll();
          req.onsuccess = () => {
            open.result.close();
            resolve(
              (req.result as { name_en: string }[])
                .map((p) => p.name_en)
                .sort(),
            );
          };
        };
      }),
  );
}

test('two shops stay apart; a shop over its sync budget keeps selling (I-cases, T-039)', async ({
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const shopA = await createShop(request, `a-${Date.now()}@e2e.test`);
  const shopB = await createShop(request, `b-${Date.now()}@e2e.test`);
  const a = await newTill(browser);
  const b = await newTill(browser);
  await setUpTill(a.page, shopA.owner_code.code, 'Cable of shop A', 10_000);
  await setUpTill(b.page, shopB.owner_code.code, 'Cable of shop B', 20_000);

  // Same barcode, each shop sees only its own product (journey 21).
  expect(await productNames(a.page)).toEqual(['Cable of shop A']);
  expect(await productNames(b.page)).toEqual(['Cable of shop B']);
  await a.page.goto('/bikri/products');
  await unlock(a.page);
  await expect(a.page.getByText('Cable of shop A')).toBeVisible();
  await expect(a.page.getByText('Cable of shop B')).toHaveCount(0);

  // Quota (journey 22): shop A's budget drops to 0 → "Daily sync limit reached", local writes go on.
  const patch = await request.patch(`${API}/admin/tenants/${shopA.tenant.id}`, {
    headers: { origin: ORIGIN },
    data: { daily_write_budget: 0 },
  });
  expect(patch.status(), await patch.text()).toBe(200);
  const saved = await a.page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Added while over budget', price: 5_000 },
    ]),
  );
  expect(saved).toHaveLength(1);
  await syncNow(a.page);
  await expect(a.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    'quota',
  );
  await expect(a.page.getByTestId('sync-badge')).toContainText(
    'Daily sync limit reached',
  );
  // Shop B keeps syncing.
  await b.page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Second cable of shop B', price: 9_000 },
    ]),
  );
  await syncNow(b.page);
  await expect(b.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    'synced',
  );

  // A browser that leaves shop B and joins shop A loses B's database (journey 21, I-case).
  await b.page.goto('/bikri/settings');
  await unlock(b.page);
  b.page.once('dialog', (d) => void d.accept());
  await b.page.getByRole('button', { name: 'Leave this shop' }).click();
  await expect(
    b.page.getByRole('heading', { name: 'Connect this device to your shop' }),
  ).toBeVisible();
  const code = await request.post(
    `${API}/admin/tenants/${shopA.tenant.id}/enrolment-codes`,
    {
      headers: { origin: ORIGIN },
      data: { device_name: 'Counter 2', grants_admin: false },
    },
  );
  expect(code.status(), await code.text()).toBe(201);
  await enrol(b.page, ((await code.json()) as { code: string }).code);
  await unlock(b.page);
  const dbs = await b.page.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name),
  );
  expect(dbs).not.toContain(`bikri-${shopB.tenant.id}`);
  expect(await productNames(b.page)).toEqual(['Cable of shop A']);
  await a.ctx.close();
  await b.ctx.close();
});
