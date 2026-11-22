import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  idbAll,
  idbCount,
  idbCountFor,
  makePng,
  setLanguage,
} from './helpers.ts';
import {
  API,
  createShop,
  enrol,
  lastCode,
  newTill,
  ORIGIN,
  shopName,
  syncNow,
  unlock,
} from './syncHelpers.ts';

// M2 journeys (10-testing §6/§8): operator creates a shop, owner enrols an admin till, confirms by
// email, adds a second till; data syncs between them; revoke and Leave this shop.

/** Raise the tenant's prune floor in the local D1 so the next pull is stale (journey 20). */
function raiseChangeLogFloor(tenantId: string): number {
  const dir = fileURLToPath(
    new URL(
      '../../apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
      import.meta.url,
    ),
  );
  const file = readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
    .map((name) => ({
      name,
      at: statSync(join(dir, name)).mtimeMs,
    }))
    .sort((left, right) => right.at - left.at)
    .at(0)?.name;
  if (!file) throw new Error(`no local D1 database under ${dir}`);
  const db = new DatabaseSync(join(dir, file));
  try {
    const table = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'change_log'",
      )
      .get();
    if (!table) throw new Error(`${file} is not the tenant D1 database`);
    const row = db
      .prepare('SELECT MAX(seq) AS seq FROM change_log WHERE tenant_id = ?')
      .get(tenantId) as { seq?: number } | undefined;
    const floor = Number(row?.seq ?? 0);
    if (floor <= 0) throw new Error('the tenant has no change_log rows');
    db.prepare('UPDATE tenants SET change_log_floor = ? WHERE id = ?').run(
      floor,
      tenantId,
    );
    return floor;
  } finally {
    db.close();
  }
}

/** Rows of one table for a tenant through the operator export (Access is bypassed in tests). */
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
      { headers: { origin: ORIGIN } },
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

test.describe.configure({ mode: 'serial' });
test.beforeEach(({ browserName: _b }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one viewport is enough');
});

test('two tills of one shop: enrol, owner sign-in, add a till, data syncs, revoke, leave', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const email = `owner-${Date.now()}@e2e.test`;
  const shop = await createShop(request, email);

  // Till A: owner pairing code → admin device → setup wizard.
  const a = await newTill(browser);
  await enrol(a.page, shop.owner_code.code, 'Counter 1');
  await expect(a.page).toHaveURL(/\/bikri\/setup/);
  await a.page.waitForFunction(() => window.__bikriTest !== undefined);
  await a.page.evaluate(() => window.__bikriTest?.finishSetupHere());
  // Client-side navigation: a full load would abort the setup push and leave its rows
  // in `sending` for the stale-reclaim window, so the sync below would fail without them.
  await a.page.evaluate(() => window.__bikriTest?.navigate('/'));
  // Wrong PIN shows tries left; the right one opens the app.
  await a.page
    .getByTestId('lock-screen')
    .getByRole('button', { name: /Adnan/ })
    .click();
  await a.page.keyboard.type('1111');
  await expect(a.page.getByRole('alert')).toContainText('4 tries left');
  await a.page.keyboard.type('4826');
  await expect(a.page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await syncNow(a.page);
  await expect(a.page.getByTestId('staff-menu')).toHaveAttribute(
    'data-sync-state',
    'synced',
  );

  // Token never in localStorage (screens/02 AC 5).
  const ls = await a.page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(ls).not.toMatch(/[A-Za-z0-9_-]{40,}/);

  // Settings → Devices asks "Confirm it's you" and mails a code.
  await a.page.goto('/bikri/settings/devices');
  await unlock(a.page);
  const dialog = a.page.getByTestId('owner-signin');
  await expect(dialog.getByText(/We sent a 6-digit code to/)).toBeVisible();
  await dialog.getByLabel('6-digit code').fill('000000');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText(/not right/)).toBeVisible();
  await dialog.getByLabel('6-digit code').fill(await lastCode(request, email));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
  await expect(a.page.getByTestId('device-list')).toContainText('Counter 1');

  await a.page.getByLabel('Device name').fill('Counter 2');
  await a.page.getByRole('button', { name: 'Get a code' }).click();
  const tillCode = (
    (await a.page.getByTestId('new-code').locator('p').first().textContent()) ??
    ''
  ).trim();
  expect(tillCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await expect(
    a.page.getByRole('img', { name: 'QR code to connect the new till' }),
  ).toBeVisible();

  // Till B: lowercase dashed code works (AC 3); shop already set up → straight into the app.
  const b = await newTill(browser);
  await enrol(b.page, tillCode.toLowerCase());
  await unlock(b.page);
  await expect(b.page.getByRole('navigation', { name: 'Main' })).toBeVisible({
    timeout: 20_000,
  });
  // Till A's setup reached till B through the server (push → pull/snapshot).
  expect(await shopName(b.page)).toBe('Algovyn Mobiles');
  // The code is single use (AC 2).
  const c = await newTill(browser);
  await c.page.goto('/bikri/enrol');
  await c.page.getByLabel('Pairing code').fill(tillCode);
  await c.page.getByRole('button', { name: 'Connect' }).click();
  await expect(
    c.page.getByText(
      'That code is wrong or expired. Ask the owner for a new one.',
    ),
  ).toBeVisible();
  await c.ctx.close();

  // A sees B in its devices list; a browser already in a shop shows Open / Leave on /enrol.
  await a.page.getByRole('button', { name: 'Refresh' }).click();
  await expect(a.page.getByTestId('device-list')).toContainText('Counter 2');

  // Owner server export (journey 24, T-053): paged from the server and zipped in the browser.
  await a.page.evaluate(() => window.__bikriTest?.navigate('/settings/backup'));
  await expect(
    a.page.getByRole('heading', { name: 'Backup & export' }),
  ).toBeVisible();
  const [serverZip] = await Promise.all([
    a.page.waitForEvent('download'),
    a.page.getByRole('button', { name: 'Download from server' }).click(),
  ]);
  const serverBytes = await readFile((await serverZip.path()) ?? '');
  expect(serverBytes.subarray(0, 2).toString('latin1')).toBe('PK');
  const serverText = serverBytes.toString('latin1');
  expect(serverText).toContain('manifest.json');
  expect(serverText).toContain('json/shop.json');
  expect(serverText).toContain('"source": "server"');
  expect(serverText).toContain('"snapshot_seq"');
  await expect(
    a.page.getByText(/Downloaded bikri-export-.* from the server/u),
  ).toBeVisible();
  await a.page.evaluate(() =>
    window.__bikriTest?.navigate('/settings/devices'),
  );

  await b.page.goto('/bikri/enrol');
  await expect(b.page.getByText(/This browser is connected to/)).toBeVisible();
  // Leaving from /enrol is not a free action: it needs an owner PIN.
  await b.page.getByRole('button', { name: 'Leave that shop' }).click();
  // The connected-shop confirmation is an inline card, not a dialog.
  await b.page.getByRole('button', { name: 'Leave that shop' }).last().click();
  const leavePin = b.page.getByRole('dialog', {
    name: 'Owner PIN needed',
  });
  await expect(leavePin).toBeVisible();
  await leavePin.getByRole('button', { name: 'Cancel' }).click();
  await b.page.goto('/bikri/');
  await expect(b.page.getByTestId('lock-screen')).toBeVisible();

  // Revoke B → B's next sync shows the enrol screen with the revoked notice (AC 4).
  const row = a.page
    .getByTestId('device-list')
    .locator('li', { hasText: 'Counter 2' });
  await row.getByRole('button', { name: 'Revoke' }).click();
  await a.page
    .getByRole('dialog')
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(row).toContainText('Revoked');
  // Lock (Ctrl+L) drops the owner session: the next server action asks for a code again (journey 24).
  await a.page.keyboard.press('Control+l');
  await unlock(a.page);
  const again = a.page.getByTestId('owner-signin');
  await expect(again).toBeVisible();
  await again.getByRole('button', { name: 'Cancel' }).click();
  await b.page.goto('/bikri/');
  await syncNow(b.page);
  await expect(
    b.page.getByText('This device was disconnected by the owner.', {
      exact: false,
    }),
  ).toBeVisible();
  const download = b.page.waitForEvent('download');
  await b.page.getByRole('button', { name: 'Export unsynced data' }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^bikri-unsynced-.+\.json$/,
  );

  // Leave this shop on A removes its database (AC 7).
  await a.page.goto('/bikri/settings');
  await unlock(a.page);
  // The leave action is intentionally blocked while the outbox has ops. Make the test wait
  // for the queue instead of racing a background sync under CI load.
  await syncNow(a.page);
  await expect
    .poll(
      async () => {
        const pending = await idbCount(a.page, 'outbox');
        if (pending > 0) await syncNow(a.page);
        return pending;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
  await a.page.getByRole('button', { name: 'Leave this shop' }).click();
  await a.page
    .getByRole('dialog', { name: 'Leave that shop' })
    .getByRole('button', { name: 'Leave this shop' })
    .click();
  await expect(
    a.page.getByRole('heading', { name: 'Connect this device to your shop' }),
  ).toBeVisible();
  // The database name may remain after Leave (clear, not delete, so a second tab can
  // never block the handover); no shop rows may remain readable.
  expect(await idbCountFor(a.page, shop.tenant.id, 'products')).toBe(0);
  expect(await idbCountFor(a.page, shop.tenant.id, 'staff')).toBe(0);
  await a.ctx.close();
  await b.ctx.close();
});

test('catalog syncs to a support till that is view-only; operator read-only blocks writes (T-027, T-026)', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const email = `owner-ro-${Date.now()}@e2e.test`;
  const shop = await createShop(request, email);
  const admin = `${API}/admin/tenants/${shop.tenant.id}`;
  const headers = { origin: ORIGIN };

  const a = await newTill(browser);
  await enrol(a.page, shop.owner_code.code, 'Counter 1');
  await a.page.waitForFunction(() => window.__bikriTest !== undefined);
  await a.page.evaluate(() => window.__bikriTest?.finishSetupHere());
  // Client-side navigation keeps the setup push alive (see journey 6 in journeys.spec).
  await a.page.evaluate(() => window.__bikriTest?.navigate('/'));
  await unlock(a.page);
  await a.page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Type-C cable 1 m', price: 149_900, cost: 110_000, stock: 5 },
    ]),
  );
  // A product photo taken on A uploads after the push (T-033) and shows on the other device.
  const png = await makePng(a.page, 800, 800);
  await a.page.evaluate(() => window.__bikriTest?.navigate('/products/new'));
  await a.page.getByLabel('Name (English)').fill('Earbuds Pro');
  await a.page.getByLabel('Sale price').fill('2500');
  await a.page
    .getByText('Take or choose photo')
    .locator('input[type=file]')
    .setInputFiles({ name: 'earbuds.png', mimeType: 'image/png', buffer: png });
  await expect(a.page.getByTestId('form-photo')).toBeVisible();
  await a.page.keyboard.press('Control+s');
  await expect(
    a.page.getByRole('heading', { name: 'Earbuds Pro' }),
  ).toBeVisible();
  await syncNow(a.page);
  await expect(a.page.getByTestId('staff-menu')).toHaveAttribute(
    'data-sync-state',
    'synced',
  );

  // Support access (13 §7.5): the operator's code enrols a support device with a view-only profile.
  const sa = await request.post(`${admin}/support-access`, {
    headers,
    data: { reason: 'Owner asked for help with prices', hours: 1 },
  });
  expect(sa.status(), await sa.text()).toBe(201);
  const supportCode = ((await sa.json()) as { code: string }).code;
  const s = await newTill(browser);
  await enrol(s.page, supportCode);
  const lock = s.page.getByTestId('lock-screen');
  await expect(lock).toBeVisible({ timeout: 20_000 });
  await lock.getByRole('button', { name: 'Algovyn support' }).click();
  await expect(s.page.getByTestId('banner-support')).toContainText(
    'Owner asked for help with prices',
  );
  // The catalog reached the support device (push from A → pull/snapshot).
  await s.page.goto('/bikri/products');
  await s.page
    .getByTestId('lock-screen')
    .getByRole('button', { name: 'Algovyn support' })
    .click();
  await expect(s.page.getByText('Type-C cable 1 m')).toBeVisible();
  await s.page.getByText('Earbuds Pro').click();
  const photo = s.page
    .getByTestId('products-detail')
    .getByTestId('product-photo');
  await expect(photo).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => photo.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(512);
  // Writes are refused on a support device.
  const supportWrite = await s.page.evaluate(() =>
    window.__bikriTest
      ?.seedProducts([{ name: 'Nope', price: 100 }])
      .then(() => 'saved')
      .catch((e: Error) => e.name),
  );
  expect(supportWrite).toBe('ReadOnlyError');

  // The owner sees the banner and ends support access; the support device is then revoked.
  await syncNow(a.page);
  const banner = a.page.getByTestId('banner-support');
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'End now' }).click();
  const dialog = a.page.getByTestId('owner-signin');
  if (await dialog.isVisible().catch(() => false)) {
    await dialog
      .getByLabel('6-digit code')
      .fill(await lastCode(request, email));
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await banner.getByRole('button', { name: 'End now' }).click();
  }
  await expect(a.page.getByText('Support access ended.')).toBeVisible();
  await expect(banner).toBeHidden();
  await syncNow(s.page);
  await expect(
    s.page.getByRole('heading', { name: 'Connect this device to your shop' }),
  ).toBeVisible();
  await s.ctx.close();

  // Operator makes the shop read-only (T-027): banner + badge, writes refused with one toast.
  const ro = await request.post(`${admin}/read-only`, {
    headers,
    data: { reason: 'Payment overdue, e2e check' },
  });
  expect(ro.status(), await ro.text()).toBe(200);
  // Two sales made before this till learned the status must still reach the server
  // (the read-only cutoff is the status change, not the device's next pull).
  await a.ctx.setOffline(true);
  for (let i = 0; i < 2; i += 1) {
    await a.page.evaluate(() => window.__bikriTest?.navigate('/sell'));
    await a.page
      .getByTestId('sell-tile')
      .filter({ hasText: 'Type-C cable' })
      .click();
    await a.page.keyboard.press('F8');
    await a.page.getByTestId('pay-done').click();
    await expect(a.page.getByTestId('sale-saved')).toBeVisible();
    // The completion screen is an overlay; close it before ringing the next sale.
    await a.page.getByRole('button', { name: 'New sale' }).click();
    await expect(a.page.getByTestId('sale-saved')).toBeHidden();
  }
  await a.ctx.setOffline(false);
  await syncNow(a.page);
  expect(await serverRows(request, shop.tenant.id, 'sales')).toBe(2);
  await expect(a.page.getByTestId('banner-read-only')).toBeVisible();
  await expect(a.page.getByTestId('staff-menu')).toHaveAttribute(
    'data-sync-state',
    'read-only',
  );
  // Sell is blocked even through a deep link; readable screens stay open.
  await a.page.evaluate(() => window.__bikriTest?.navigate('/sell'));
  await expect(a.page).not.toHaveURL(/\/sell/u);
  for (const [path, heading] of [
    ['/sales', 'Sales'],
    ['/reports', 'Reports'],
    ['/settings/activity', 'Activity'],
    ['/settings/backup', 'Backup & export'],
  ] as const) {
    await a.page.evaluate((to) => window.__bikriTest?.navigate(to), path);
    await expect(
      a.page.getByRole('heading', { name: heading, exact: false }).first(),
    ).toBeVisible();
  }
  // Journey 23 requires the banner in both languages, not English only.
  await setLanguage(a.page, 'ur');
  await expect(a.page.getByTestId('banner-read-only')).toContainText(
    'یہ دکان صرف دیکھنے کے لیے ہے',
  );
  await setLanguage(a.page, 'en');
  await a.page.evaluate(() => {
    void window.__bikriTest?.seedProducts([{ name: 'Blocked', price: 100 }]);
  });
  await expect(
    a.page.getByText("Read-only shop: this can't be saved."),
  ).toBeVisible();

  // Reactivate → the till leaves read-only on its next sync.
  const re = await request.post(`${admin}/reactivate`, {
    headers,
    data: { reason: 'Paid, e2e check', to: 'active' },
  });
  expect(re.status(), await re.text()).toBe(200);
  await syncNow(a.page);
  await expect(a.page.getByTestId('banner-read-only')).toBeHidden();
  await a.ctx.close();
});

test('operator console needs the Access email allowlist and same-origin (I17)', async ({
  request,
}) => {
  const crossSite = await request.get(`${API}/admin/tenants`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  expect(crossSite.status()).toBe(403);
  // The test bypass still enforces OWNER_EMAILS; a non-operator identity never opens the console.
  const notOperator = await request.get(`${API}/admin/tenants`, {
    headers: { 'x-test-access-email': 'till@example.test' },
  });
  expect(notOperator.status()).toBe(403);
});

test('journey 20: a stale till gets 410 SNAPSHOT_REQUIRED, snapshots, then recovers from a new restore_epoch', async ({
  browser,
  request,
}) => {
  test.setTimeout(210_000);
  const email = `stale-${Date.now()}@e2e.test`;
  const shop = await createShop(request, email);
  const admin = `${API}/admin/tenants/${shop.tenant.id}`;
  const headers = { origin: ORIGIN };
  const a = await newTill(browser);
  await enrol(a.page, shop.owner_code.code, 'Counter 1');
  await a.page.waitForFunction(() => window.__bikriTest !== undefined);
  await a.page.evaluate(() => window.__bikriTest?.finishSetupHere());
  await a.page.evaluate(() => window.__bikriTest?.navigate('/'));
  await unlock(a.page);
  await a.page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Charger 20 W', price: 150_000, cost: 100_000, stock: 20 },
    ]),
  );
  await syncNow(a.page);
  await expect(a.page.getByTestId('staff-menu')).toHaveAttribute(
    'data-sync-state',
    'synced',
    { timeout: 30_000 },
  );

  // A sale the server has not seen yet must survive the forced snapshot.
  const restorePoint = Date.now();
  const syncResponses: { url: string; status: number }[] = [];
  a.page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/sync/pull') || url.includes('/api/sync/snapshot'))
      syncResponses.push({ url, status: response.status() });
  });
  await a.ctx.setOffline(true);
  await a.page.evaluate(() => window.__bikriTest?.navigate('/sell'));
  await a.page.getByTestId('sell-tile').filter({ hasText: 'Charger' }).click();
  await a.page.keyboard.press('F8');
  await a.page.getByTestId('pay-done').click();
  await expect(a.page.getByTestId('sale-saved')).toBeVisible();
  const offlineSale = (
    await idbAll<{ created_at: number }>(a.page, 'sales')
  )[0];
  expect(Number(offlineSale?.created_at)).toBeGreaterThanOrEqual(restorePoint);

  // A second till adds a product after A's last pull. Only the forced snapshot can
  // bring it to A, so finding it proves the snapshot actually hydrated IndexedDB.
  const bCode = await request.post(`${admin}/enrolment-codes`, {
    headers,
    data: { device_name: 'Counter 2', grants_admin: false },
  });
  expect(bCode.status(), await bCode.text()).toBe(201);
  const b = await newTill(browser);
  await enrol(b.page, ((await bCode.json()) as { code: string }).code);
  await b.page.waitForFunction(() => window.__bikriTest !== undefined);
  await unlock(b.page);
  await b.page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Snapshot only', price: 25_000, cost: 10_000, stock: 5 },
    ]),
  );
  await syncNow(b.page);
  await expect(b.page.getByTestId('staff-menu')).toHaveAttribute(
    'data-sync-state',
    'synced',
    { timeout: 30_000 },
  );

  // The server's nightly prune moved the floor past this till's cursor. Set the client
  // cursor low and the tenant floor to the current maximum: the next pull is stale.
  await a.page.evaluate(() => window.__bikriTest?.setKv('pull_cursor', 0));
  const floor = raiseChangeLogFloor(shop.tenant.id);
  await a.ctx.setOffline(false);
  await a.page.evaluate(() => window.__bikriTest?.navigate('/'));
  await syncNow(a.page);
  await expect(a.page.getByTestId('staff-menu')).toHaveAttribute(
    'data-sync-state',
    'synced',
    { timeout: 30_000 },
  );
  expect(await idbAll(a.page, 'sales')).toHaveLength(1);
  expect(await serverRows(request, shop.tenant.id, 'sales')).toBe(1);
  expect(
    (await idbAll<{ name_en: string }>(a.page, 'products')).map(
      (product) => product.name_en,
    ),
  ).toContain('Snapshot only');
  const cursor = (
    await idbAll<{ key: string; value: number }>(a.page, 'kv')
  ).find((row) => row.key === 'pull_cursor')?.value;
  expect(Number(cursor)).toBeGreaterThanOrEqual(floor);
  expect(
    syncResponses.some(
      (response) =>
        response.url.includes('/api/sync/pull') && response.status === 410,
    ),
  ).toBe(true);
  expect(
    syncResponses.some(
      (response) =>
        response.url.includes('/api/sync/snapshot') && response.status === 200,
    ),
  ).toBe(true);
  await b.ctx.close();

  // A restore sets a new epoch; the till recovers without duplicating its sale.
  const epochBefore = (
    await idbAll<{ key: string; value: unknown }>(a.page, 'kv')
  ).find((row) => row.key === 'restore_epoch')?.value;
  const maintenance = await request.post(`${admin}/maintenance`, {
    headers,
    data: { on: true, reason: 'Journey 20 restore drill' },
  });
  expect(maintenance.status(), await maintenance.text()).toBe(200);
  const epoch = await request.post(`${admin}/restore-epoch`, {
    headers,
    data: {
      restore_point_at: restorePoint,
      reason: 'Journey 20 restore drill',
    },
  });
  expect(epoch.status(), await epoch.text()).toBe(200);
  const epochBody = (await epoch.json()) as {
    tenant: { restore_epoch: string };
  };
  expect(epochBody.tenant.restore_epoch).not.toBe(epochBefore);
  const done = await request.post(`${admin}/maintenance`, {
    headers,
    data: {
      on: false,
      reason: 'Journey 20 restore drill finished',
      to: 'active',
    },
  });
  expect(done.status(), await done.text()).toBe(200);
  await syncNow(a.page);
  // A restore recovery may return the till to the lock screen; unlock and confirm.
  if (
    await a.page
      .getByTestId('lock-screen')
      .isVisible()
      .catch(() => false)
  )
    await unlock(a.page);
  await expect(a.page.getByTestId('staff-menu')).toHaveAttribute(
    'data-sync-state',
    'synced',
    { timeout: 30_000 },
  );
  expect(await idbAll(a.page, 'sales')).toHaveLength(1);
  expect(await serverRows(request, shop.tenant.id, 'sales')).toBe(1);
  expect(
    (await idbAll<{ key: string; value: unknown }>(a.page, 'kv')).find(
      (row) => row.key === 'restore_epoch',
    )?.value,
  ).toBe(epochBody.tenant.restore_epoch);
  expect(
    (
      await idbAll<{ recovery?: number; status: string }>(a.page, 'outbox')
    ).filter((op) => op.recovery && op.status === 'pending'),
  ).toHaveLength(0);
  await a.ctx.close();
});
