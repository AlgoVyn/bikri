import { expect, type Page, test } from '@playwright/test';
import { idbAll } from './helpers.ts';
import {
  API,
  createShop,
  enrol,
  newTill,
  ORIGIN,
  syncNow,
  unlock,
} from './syncHelpers.ts';

// M2 journeys 6, 7 and 15 (10-testing §6) against `wrangler dev`, desktop only.
test.describe.configure({ mode: 'serial' });
test.beforeEach(({ browserName: _b }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one viewport is enough');
});

type Row = Record<string, unknown>;
const headers = { origin: ORIGIN };

async function ownerTill(page: Page, code: string) {
  await enrol(page, code);
  await page.waitForFunction(() => window.__bikriTest !== undefined);
  await page.evaluate(() => window.__bikriTest?.finishSetupHere());
  await page.goto('/bikri/');
  await unlock(page);
}

async function sellOne(page: Page, name: string) {
  await page.getByTestId('sell-tile').filter({ hasText: name }).click();
  await page.keyboard.press('F8');
  const pay = page.getByRole('dialog', { name: 'Take payment' });
  await pay.getByTestId('pay-done').click();
  const done = page.getByRole('dialog', { name: 'Sale complete' });
  await expect(done.getByTestId('sale-saved')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(done).toHaveCount(0);
}

async function serverRows(
  request: import('@playwright/test').APIRequestContext,
  tenantId: string,
  tbl: string,
): Promise<number> {
  const res = await request.get(`${API}/admin/tenants/${tenantId}/export`, {
    headers,
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as {
    tables: { tbl: string; rows: number }[];
  };
  return body.tables.find((t) => t.tbl === tbl)?.rows ?? -1;
}

async function onHand(page: Page, productId: string): Promise<number> {
  const moves = await idbAll<Row>(page, 'stock_movements');
  return moves
    .filter((m) => m.product_id === productId)
    .reduce((n, m) => n + Number(m.qty_delta_milli), 0);
}

test('journey 6: five offline sales survive a reload and reach the server', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const shop = await createShop(request, `j6-${Date.now()}@e2e.test`);
  const a = await newTill(browser);
  await ownerTill(a.page, shop.owner_code.code);
  await a.page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Charger 20 W', price: 150_000, stock: 20 },
    ]),
  );
  await syncNow(a.page);
  await expect(a.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    'synced',
  );
  // Let the service worker take control so the app reloads offline.
  await a.page.evaluate(
    async () => (await navigator.serviceWorker.ready).active?.state,
  );
  await a.page.goto('/bikri/sell');
  await unlock(a.page);

  await a.ctx.setOffline(true);
  await expect(a.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    'offline',
  );
  for (let i = 0; i < 5; i += 1) await sellOne(a.page, 'Charger 20 W');
  await a.page.reload();
  await unlock(a.page);
  expect(await idbAll(a.page, 'sales')).toHaveLength(5);

  await a.ctx.setOffline(false);
  await syncNow(a.page);
  await expect(a.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    'synced',
  );
  expect(await serverRows(request, shop.tenant.id, 'sales')).toBe(5);
  await a.ctx.close();
});

test('journey 7 + 15: two tills merge price edits and oversell the last unit; a non-admin till cannot manage devices; suspend pauses sync', async ({
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const shop = await createShop(request, `j7-${Date.now()}@e2e.test`);
  const a = await newTill(browser);
  await ownerTill(a.page, shop.owner_code.code);
  const [productId] =
    (await a.page.evaluate(() =>
      window.__bikriTest?.seedProducts([
        { name: 'Last phone', price: 5_000_000, cost: 4_000_000, stock: 1 },
      ]),
    )) ?? [];
  expect(productId).toBeTruthy();
  await syncNow(a.page);

  const code = await request.post(
    `${API}/admin/tenants/${shop.tenant.id}/enrolment-codes`,
    { headers, data: { device_name: 'Counter 2', grants_admin: false } },
  );
  expect(code.status(), await code.text()).toBe(201);
  const b = await newTill(browser);
  await enrol(b.page, ((await code.json()) as { code: string }).code);
  await unlock(b.page);
  expect(await onHand(b.page, productId as string)).toBe(1000);

  // A non-admin till: Settings → Devices offers no actions (journey 15).
  await b.page.evaluate(() =>
    window.__bikriTest?.navigate('/settings/devices'),
  );
  await expect(
    b.page.getByText('Only the owner can manage devices, on an admin device.'),
  ).toBeVisible();

  // Both offline: A changes the price, B the brand, and both sell the last unit.
  await a.ctx.setOffline(true);
  await b.ctx.setOffline(true);
  await a.page.evaluate(
    (id) => window.__bikriTest?.navigate(`/products/${id}/edit`),
    productId,
  );
  await a.page.getByLabel('Sale price').fill('52000');
  await a.page.keyboard.press('Control+s');
  await expect(
    a.page.getByRole('heading', { name: 'Last phone' }),
  ).toBeVisible();
  await b.page.evaluate(
    (id) => window.__bikriTest?.navigate(`/products/${id}/edit`),
    productId,
  );
  await b.page.getByLabel('Brand').fill('Samsung');
  await b.page.keyboard.press('Control+s');
  await expect(
    b.page.getByRole('heading', { name: 'Last phone' }),
  ).toBeVisible();
  for (const t of [a, b]) {
    await t.page.evaluate(() => window.__bikriTest?.navigate('/sell'));
    await sellOne(t.page, 'Last phone');
  }

  await a.ctx.setOffline(false);
  await b.ctx.setOffline(false);
  await syncNow(a.page);
  await syncNow(b.page);
  await syncNow(a.page);
  for (const t of [a, b]) {
    const [p] = (await idbAll<Row>(t.page, 'products')).filter(
      (r) => r.id === productId,
    );
    expect(p).toMatchObject({ price: 5_200_000, brand: 'Samsung' });
    expect(await onHand(t.page, productId as string)).toBe(-1000);
  }
  expect(await serverRows(request, shop.tenant.id, 'sales')).toBe(2);

  // Suspend (journey 15): sync pauses, the till keeps selling; reactivate resumes with nothing lost.
  const sus = await request.post(
    `${API}/admin/tenants/${shop.tenant.id}/suspend`,
    { headers, data: { reason: 'Abuse check (e2e)' } },
  );
  expect(sus.status(), await sus.text()).toBe(200);
  await a.page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Cable', price: 50_000, stock: 5 },
    ]),
  );
  await syncNow(a.page);
  await expect(a.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    'paused',
  );
  await sellOne(a.page, 'Cable');
  const re = await request.post(
    `${API}/admin/tenants/${shop.tenant.id}/reactivate`,
    { headers, data: { reason: 'Cleared (e2e)', to: 'active' } },
  );
  expect(re.status(), await re.text()).toBe(200);
  await syncNow(a.page);
  await expect(a.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    'synced',
  );
  expect(await serverRows(request, shop.tenant.id, 'sales')).toBe(3);
  await a.ctx.close();
  await b.ctx.close();
});
