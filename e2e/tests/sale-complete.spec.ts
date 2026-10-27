import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { idbAll, openReadyShop } from './helpers.ts';

// T-018: Sale complete + share (screens/07 ACs 1–4).

type Row = Record<string, unknown>;

const GALAXY = '8901234567890';
const BUDS = '8900000000011';

async function shop(page: Page): Promise<void> {
  await openReadyShop(page, '/bikri/sell');
  await page.evaluate(
    (list) => window.__bikriTest?.seedProducts(list),
    [
      {
        name: 'Galaxy A15',
        price: 4200000,
        cost: 3800000,
        stock: 3,
        barcode: GALAXY,
      },
      {
        name: 'Earbuds',
        price: 350000,
        cost: 200000,
        stock: 5,
        barcode: BUDS,
      },
    ],
  );
}

const tile = (page: Page, name: string) =>
  page.getByTestId('sell-tile').filter({ hasText: name });
const modal = (page: Page) => page.getByRole('dialog').first();

/** Galaxy A15 for Rs 42,000, cash Rs 45,000 → Sale complete. Returns the pay step's change text. */
async function sellGalaxy(page: Page, received = '45000'): Promise<string> {
  await tile(page, 'Galaxy A15').click();
  await page.keyboard.press('F8');
  await modal(page).getByTestId('pay-done').waitFor();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(received);
  const change =
    (await modal(page).getByTestId('pay-change').textContent()) ?? '';
  await modal(page).getByTestId('pay-done').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
  return change;
}

/** A USB scanner: characters a few ms apart, then Enter. */
async function scan(page: Page, code: string): Promise<void> {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
}

async function expectNewCartWithBuds(page: Page): Promise<void> {
  await expect(page.getByTestId('sale-complete')).toHaveCount(0);
  await expect(
    page.getByTestId('cart-bar').or(page.getByTestId('total-to-pay')).first(),
  ).toContainText('3,500');
  await expect
    .poll(async () => {
      const carts = await idbAll<{ id: string; lines: { name: string }[] }>(
        page,
        'carts',
      );
      return carts.flatMap((c) => c.lines.map((l) => l.name));
    })
    .toEqual(['Earbuds']);
}

test.describe('Sale complete (T-018)', () => {
  test('AC 4 + AC 1: change matches the pay step; a scan closes the screen and starts the next sale', async ({
    page,
  }) => {
    await shop(page);
    const change = await sellGalaxy(page);
    expect(change).toBe('Change to give Rs 3,000');
    await expect(page.getByTestId('done-change')).toHaveText(change);
    await expect(page.getByTestId('sale-saved')).toHaveText(
      'Sale saved · A-A-1',
    );
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);
    // No printer set up: nothing queued, so no status line.
    await expect(page.getByTestId('print-status')).toHaveCount(0);
    await scan(page, BUDS);
    await expectNewCartWithBuds(page);
    expect(await idbAll(page, 'sales')).toHaveLength(1);
  });

  test('AC 2: Share makes a PNG of the receipt and opens wa.me for a customer with a phone; Download PDF', async ({
    page,
  }) => {
    await page
      .context()
      .route('https://wa.me/**', (route) =>
        route.fulfill({ body: 'whatsapp', contentType: 'text/plain' }),
      );
    await shop(page);
    await page.evaluate(async () => {
      await window.__bikriTest?.seedCustomer({
        name: 'Ali',
        phone: '03001234567',
        limit: null,
      });
      const data = new Uint8Array(64 * 16).fill(0);
      await window.__bikriTest?.setKv('logo_bitmap', {
        width: 64,
        height: 16,
        data,
        format: 'gray',
      });
    });
    await tile(page, 'Galaxy A15').click();
    await page.keyboard.press('F8');
    await modal(page)
      .getByRole('tab', { name: /Udhaar/ })
      .click();
    await modal(page).getByRole('button', { name: 'Choose customer' }).click();
    await page
      .getByRole('dialog', { name: 'Customer' })
      .getByRole('button', { name: /^Ali/ })
      .click();
    await modal(page).getByTestId('pay-done').click();
    await expect(page.getByTestId('done-udhaar')).toBeVisible();

    const [download, popup] = await Promise.all([
      page.waitForEvent('download'),
      page.waitForEvent('popup'),
      page.getByRole('button', { name: 'Send on WhatsApp' }).click(),
    ]);
    const url = new URL(popup.url());
    expect(url.origin + url.pathname).toBe('https://wa.me/923001234567');
    const text = url.searchParams.get('text') ?? '';
    expect(text).toContain('Bill A-A-1');
    expect(text).toContain('Galaxy A15 × 1');
    expect(text).toContain('Udhaar Rs 42,000');
    expect(download.suggestedFilename()).toBe('A-A-1.png');
    const png = await readFile((await download.path()) as string);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    // 80 mm: 576 dots + 16 px white margin each side.
    expect(png.readUInt32BE(16)).toBe(608);
    expect(png.readUInt32BE(20)).toBeGreaterThan(600);
    await expect(page.getByText('Receipt picture saved.')).toBeVisible();

    const [pdf] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download PDF' }).click(),
    ]);
    expect(pdf.suggestedFilename()).toBe('A-A-1.pdf');
    const bytes = await readFile((await pdf.path()) as string);
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
  });

  test('AC 3: Print again queues a reprint with REPRINT under the title; status line, retry and Open bill', async ({
    page,
  }) => {
    await shop(page);
    await sellGalaxy(page);
    await page.keyboard.press('p');
    await expect(page.getByTestId('print-status')).toHaveText(
      'Receipt waiting for a printer — set one up in Settings',
    );
    const [job] = await idbAll<Row>(page, 'print_jobs');
    expect(job).toMatchObject({
      kind: 'sale',
      status: 'queued',
      reprint: true,
    });
    const text = await page.evaluate(
      (id) => window.__bikriTest?.printJobText(id),
      String(job?.id),
    );
    const rows = (text ?? '').split('\n').map((l) => l.trim());
    expect(rows[rows.indexOf('SALE RECEIPT') + 1]).toBe('REPRINT');
    expect(rows).toContain('Powered by AlgoVyn');

    await page.evaluate(() =>
      window.__bikriTest?.setKv('printer', { transport: 'usb', paper_mm: 80 }),
    );
    await expect(page.getByTestId('print-status')).toHaveText('Printing…');
    await page.evaluate(
      (id) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('bikri-dev');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction('print_jobs', 'readwrite');
            const store = tx.objectStore('print_jobs');
            const get = store.get(id);
            get.onsuccess = () =>
              store.put({
                ...get.result,
                status: 'failed',
                error: 'NO_DEVICE',
              });
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
          };
        }),
      String(job?.id),
    );
    // The failed → Retry path is covered in apps/pos/src/data/receipt.test.ts (raw IDB writes
    // do not wake Dexie live queries); here a second Print again must add a second job.
    await page.getByRole('button', { name: /Print again/ }).click();
    const jobs = await idbAll<Row>(page, 'print_jobs');
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((j) => j.reprint === true)).toHaveLength(2);

    await page.getByRole('button', { name: 'Open bill' }).click();
    await expect(page).toHaveURL(/\/bikri\/sales\/[A-Z0-9]+$/u);
  });

  test('Urdu: scan after the sale starts the next one; change matches', async ({
    page,
  }) => {
    await shop(page);
    await page.getByLabel('Language').selectOption('ur');
    const change = await sellGalaxy(page, '50000');
    await expect(page.getByTestId('done-change')).toHaveText(change);
    await expect(page.getByTestId('done-change')).toContainText('8,000');
    await expect(
      page.getByRole('button', { name: 'دوبارہ پرنٹ' }),
    ).toBeVisible();
    await scan(page, BUDS);
    await expectNewCartWithBuds(page);
  });
});
