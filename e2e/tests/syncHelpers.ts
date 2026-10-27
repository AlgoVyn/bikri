/** Shared M2 sync/e2e helpers: operator-created shops, enrolment, PIN unlock and sync. */
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
} from '@playwright/test';

export const ORIGIN = 'http://localhost:8787';
export const API = '/bikri/api';

export async function createShop(
  request: APIRequestContext,
  ownerEmail: string,
  extra: Record<string, unknown> = {},
) {
  const slug = `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const res = await request.post(`${API}/admin/tenants`, {
    headers: { origin: ORIGIN },
    data: {
      slug,
      display_name: `E2E ${slug}`,
      owner_email: ownerEmail,
      ...extra,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as {
    tenant: { id: string; display_name: string };
    owner_code: { code: string; link: string };
  };
  return body;
}

export async function lastCode(
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

export async function enrol(page: Page, code: string, name?: string) {
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
export async function unlock(page: Page, name = 'Adnan', pin = '4826') {
  const lock = page.getByTestId('lock-screen');
  await expect(lock).toBeVisible({ timeout: 20_000 });
  await lock.getByRole('button', { name: new RegExp(name) }).click();
  await page.keyboard.type(pin);
  await expect(lock).toBeHidden();
}

export async function syncNow(page: Page) {
  await page.waitForFunction(() => window.__bikriTest !== undefined);
  await page.evaluate(() => window.__bikriTest?.syncNow());
}

/** The shop row's name in the page's active shop database. */
export function shopName(page: Page): Promise<string | null> {
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

export async function newTill(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}
