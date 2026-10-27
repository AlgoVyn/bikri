import { expect, type Page } from '@playwright/test';

/** Opens the app with a finished setup (bikri-dev, owner PIN 4826) and waits for the shell. */
export async function openReadyShop(
  page: Page,
  path = '/bikri/',
): Promise<void> {
  await page.goto('/bikri/setup');
  await page.waitForFunction(() => window.__bikriTest !== undefined);
  await page.evaluate(() => window.__bikriTest?.seedReadyShop());
  await page.goto(path);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** No element may stick out past the viewport (screens/04 AC 5). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Row count of a store in the dev shop's database. */
export async function idbCount(page: Page, store: string): Promise<number> {
  return page.evaluate(
    (s) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('bikri-dev');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result
            .transaction(s, 'readonly')
            .objectStore(s)
            .count();
          req.onsuccess = () => {
            open.result.close();
            resolve(req.result);
          };
        };
      }),
    store,
  );
}

/** All rows of a store in the dev shop's database. */
export async function idbAll<T = Record<string, unknown>>(
  page: Page,
  store: string,
): Promise<T[]> {
  return page.evaluate(
    (s) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('bikri-dev');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result
            .transaction(s, 'readonly')
            .objectStore(s)
            .getAll();
          req.onsuccess = () => {
            open.result.close();
            resolve(req.result as T[]);
          };
        };
      }),
    store,
  );
}

/** A PNG made in the page (w×h, two colours) for file inputs. */
export async function makePng(
  page: Page,
  width: number,
  height: number,
): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.fillStyle = '#006bb3';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
      return c.toDataURL('image/png').split(',')[1] ?? '';
    },
    [width, height] as const,
  );
  return Buffer.from(b64, 'base64');
}

declare global {
  interface Window {
    __bikriTest?: {
      seedReadyShop: () => Promise<void>;
      reset: () => Promise<void>;
      unlockAs: (
        role: 'owner' | 'manager' | 'cashier',
        name?: string,
      ) => Promise<string>;
      seedTodaySales: () => Promise<void>;
      setKv: (key: string, value: unknown) => Promise<void>;
      navigate: (to: string) => Promise<void>;
      seedProducts: (
        list: {
          name: string;
          price: number;
          cost?: number;
          barcode?: string;
          stock?: number;
          track?: boolean;
        }[],
      ) => Promise<string[]>;
      seedManyProducts: (n: number) => Promise<void>;
      beeps: () => number;
      seedCustomer: (c: {
        name: string;
        phone?: string;
        limit?: number | null;
        hard?: boolean;
        balance?: number;
      }) => Promise<string>;
      printJobText: (id: string) => Promise<string | null>;
    };
  }
}
