import { expect, test } from '@playwright/test';
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
  await a.page.goto('/bikri/');
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
  await expect(a.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
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
  await b.page.goto('/bikri/enrol');
  await expect(b.page.getByText(/This browser is connected to/)).toBeVisible();

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
  a.page.once('dialog', (d) => void d.accept());
  await a.page.getByRole('button', { name: 'Leave this shop' }).click();
  await expect(
    a.page.getByRole('heading', { name: 'Connect this device to your shop' }),
  ).toBeVisible();
  const dbs = await a.page.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name),
  );
  expect(dbs).not.toContain(`bikri-${shop.tenant.id}`);
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
  await a.page.goto('/bikri/');
  await unlock(a.page);
  await a.page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Type-C cable 1 m', price: 149_900, cost: 110_000, stock: 5 },
    ]),
  );
  await syncNow(a.page);
  await expect(a.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
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
  await syncNow(a.page);
  await expect(a.page.getByTestId('banner-read-only')).toBeVisible();
  await expect(a.page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    'read-only',
  );
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

test('operator console needs Access; till tokens never open /admin (I17)', async ({
  request,
}) => {
  const res = await request.get(`${API}/admin/tenants`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  expect(res.status()).toBe(403);
});
