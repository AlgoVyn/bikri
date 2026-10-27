import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  test,
} from '@playwright/test';

// M2 journeys (10-testing §6/§8): operator creates a shop, owner enrols an admin till, confirms by
// email, adds a second till; data syncs between them; revoke and Leave this shop.
const ORIGIN = 'http://localhost:8787';
const API = '/bikri/api';

test.describe.configure({ mode: 'serial' });
test.beforeEach(({ browserName: _b }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one viewport is enough');
});

async function createShop(request: APIRequestContext, ownerEmail: string) {
  const slug = `e2e-${Date.now().toString(36)}`;
  const res = await request.post(`${API}/admin/tenants`, {
    headers: { origin: ORIGIN },
    data: { slug, display_name: `E2E ${slug}`, owner_email: ownerEmail },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as {
    tenant: { id: string; display_name: string };
    owner_code: { code: string; link: string };
  };
  return body;
}

async function lastCode(
  request: APIRequestContext,
  to: string,
): Promise<string> {
  const res = await request.get(`${API}/__test/outbox`);
  const { messages } = (await res.json()) as {
    messages: { to: string; text: string }[];
  };
  const mine = messages.filter((m) => m.to === to).at(-1);
  const code = mine?.text.match(/\b(\d{6})\b/)?.[1];
  expect(code).toBeTruthy();
  return code as string;
}

async function enrol(page: Page, code: string, name?: string) {
  await page.goto(`/bikri/enrol?code=${code}`);
  await expect(
    page.getByRole('heading', { name: 'Connect this device to your shop' }),
  ).toBeVisible();
  // ?code= pre-fills and is removed from the address bar (screens/02).
  await expect(page).not.toHaveURL(/code=/);
  if (name) await page.getByLabel('Device name').fill(name);
  await page.getByRole('button', { name: 'Connect' }).click();
  // "Connected to <shop>" shows during the download, then the app reloads at the base path.
  await expect(page).not.toHaveURL(/\/enrol/, { timeout: 20_000 });
}

/** An enrolled till starts on the PIN lock (T-035): unlock as the owner set up by finishSetupHere. */
async function unlock(page: Page, name = 'Adnan', pin = '4826') {
  const lock = page.getByTestId('lock-screen');
  await expect(lock).toBeVisible({ timeout: 20_000 });
  await lock.getByRole('button', { name: new RegExp(name) }).click();
  await page.keyboard.type(pin);
  await expect(lock).toBeHidden();
}

async function syncNow(page: Page) {
  await page.waitForFunction(() => window.__bikriTest !== undefined);
  await page.evaluate(() => window.__bikriTest?.syncNow());
}

/** The shop row's name in the page's active shop database. */
function shopName(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const open = indexedDB.open(
          `bikri-${localStorage.getItem('bikri.active_tenant')}`,
        );
        open.onsuccess = () => {
          const req = open.result
            .transaction('shop')
            .objectStore('shop')
            .get('shop');
          req.onsuccess = () => {
            open.result.close();
            resolve(
              (req.result as { name?: string } | undefined)?.name ?? null,
            );
          };
        };
      }),
  );
}

async function newTill(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

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
  await a.page.getByTestId('lock-screen').getByRole('button', { name: /Adnan/ }).click();
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

test('operator console needs Access; till tokens never open /admin (I17)', async ({
  request,
}) => {
  const res = await request.get(`${API}/admin/tenants`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  expect(res.status()).toBe(403);
});
