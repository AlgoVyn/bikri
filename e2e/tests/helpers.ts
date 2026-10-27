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
        const open = indexedDB.open(
          `bikri-${localStorage.getItem('bikri.active_tenant') ?? 'dev'}`,
        );
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

/** All rows of a store in the open shop's database (the dev shop unless enrolled). */
export async function idbAll<T = Record<string, unknown>>(
  page: Page,
  store: string,
): Promise<T[]> {
  return page.evaluate(
    (s) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open(
          `bikri-${localStorage.getItem('bikri.active_tenant') ?? 'dev'}`,
        );
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

/** Inserts (or replaces) one row in a store of the open shop's database. */
export async function idbPut<T = Record<string, unknown>>(
  page: Page,
  store: string,
  value: T,
): Promise<void> {
  await page.evaluate(
    ([s, v]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(
          `bikri-${localStorage.getItem('bikri.active_tenant') ?? 'dev'}`,
        );
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(s, 'readwrite');
          tx.objectStore(s).put(v);
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [store, value] as const,
  );
}

/** Updates one row by key in a store of the open shop's database. */
export async function idbUpdate(
  page: Page,
  store: string,
  key: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ store: s, key: k, patch: p }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(
          `bikri-${localStorage.getItem('bikri.active_tenant') ?? 'dev'}`,
        );
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(s, 'readwrite');
          const os = tx.objectStore(s);
          const get = os.get(k);
          get.onsuccess = () => {
            os.put({ ...get.result, ...p });
          };
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { store, key, patch },
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
      finishSetupHere: () => Promise<void>;
      syncNow: () => Promise<void>;
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
          name_ur?: string;
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

/**
 * Fake WebUSB and Web Serial receipt printers (T-020). Bytes land in `window.__printed`;
 * `window.__printerUnplugged = true` makes the next write fail like a pulled cable.
 * A granted device survives reloads (like Chrome's permission) through localStorage.
 */
export async function installFakePrinters(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __printed: { via: string; bytes: number[] }[];
      __printerUnplugged: boolean;
    };
    w.__printed = [];
    w.__printerUnplugged = false;
    const record = (via: string, data: ArrayBufferView) => {
      if (w.__printerUnplugged)
        throw new DOMException('device gone', 'NotFoundError');
      w.__printed.push({
        via,
        bytes: Array.from(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        ),
      });
    };
    const device = {
      vendorId: 0x0416,
      productId: 0x5011,
      serialNumber: 'P1',
      productName: 'POS-80',
      opened: false,
      configuration: null as unknown,
      async open() {
        device.opened = true;
      },
      async selectConfiguration() {
        device.configuration = {
          interfaces: [
            {
              interfaceNumber: 0,
              alternates: [
                {
                  interfaceClass: 7,
                  endpoints: [
                    { endpointNumber: 2, direction: 'out', type: 'bulk' },
                  ],
                },
              ],
            },
          ],
        };
      },
      async claimInterface() {},
      async transferOut(_ep: number, data: ArrayBufferView) {
        record('usb', data);
        return { status: 'ok' };
      },
    };
    const usbGranted = () => localStorage.getItem('fake-usb') === '1';
    Object.defineProperty(navigator, 'usb', {
      configurable: true,
      value: {
        async requestDevice() {
          localStorage.setItem('fake-usb', '1');
          return device;
        },
        async getDevices() {
          return usbGranted() ? [device] : [];
        },
      },
    });
    const port = {
      readable: null,
      writable: null as unknown,
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
      async open() {
        port.writable = {
          getWriter: () => ({
            write: async (b: Uint8Array) => record('serial', b),
            releaseLock: () => {},
          }),
        };
      },
    };
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: {
        async requestPort() {
          localStorage.setItem('fake-serial', '1');
          return port;
        },
        async getPorts() {
          return localStorage.getItem('fake-serial') === '1' ? [port] : [];
        },
      },
    });
  });
}

/** Everything the fake printers received, as latin1 text. */
export async function printedText(page: Page, via?: string): Promise<string> {
  return page.evaluate(
    (v) =>
      (
        window as unknown as { __printed: { via: string; bytes: number[] }[] }
      ).__printed
        .filter((p) => !v || p.via === v)
        .map((p) => String.fromCharCode(...p.bytes))
        .join(''),
    via,
  );
}
