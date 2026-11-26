import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  idbAll,
  idbUpdate,
  openReadyShop,
  setLanguage,
} from './helpers.ts';

// v1.2 quotations (D-305, screens/21). Every scenario runs in English and Urdu;
// Playwright repeats it at 1280×800 and 390×844.

type Row = Record<string, unknown>;
type Locale = 'en' | 'ur';

const LOCALES: Locale[] = ['en', 'ur'];
const PRODUCT = 'Galaxy A15';
const PRICE = 4_200_000;
const NEW_PRICE = 4_500_000;

const tile = (page: Page, name = PRODUCT) =>
  page.getByTestId('sell-tile').filter({ hasText: name });

/** Phones keep the cart in a sheet; open it before using a cart action. */
async function openCart(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) >= 1024) return;
  const bar = page.getByTestId('cart-bar');
  await bar.waitFor({ state: 'visible' });
  if ((await bar.getAttribute('aria-expanded')) !== 'true') await bar.click();
}

/** Detail actions that live in the More menu on phones. */
async function detailAction(
  page: Page,
  testId: string,
  menuName: RegExp,
): Promise<void> {
  const direct = page.getByTestId(testId);
  if ((await direct.count()) > 0 && (await direct.isVisible())) {
    await direct.click();
    return;
  }
  await page.getByTestId('page-actions-more').click();
  await page
    .getByTestId('quote-detail')
    .getByRole('button', { name: menuName })
    .click();
}

async function createQuote(page: Page, locale: Locale): Promise<string> {
  await openReadyShop(page, '/bikri/sell');
  await setLanguage(page, locale);
  if (locale === 'ur')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.evaluate(
    (list) => window.__bikriTest?.seedProducts(list),
    [{ name: PRODUCT, price: PRICE, cost: 3_800_000, stock: 10 }],
  );
  await page.evaluate(() => window.__bikriTest?.navigate('/quotations'));
  await expect(page.getByTestId('new-quote')).toBeVisible();
  await page.getByTestId('new-quote').click();
  await expect(page).toHaveURL(/\/sell/u);
  await expect(tile(page)).toBeVisible();
  await tile(page).click();
  await openCart(page);
  await page.getByTestId('save-quote').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByTestId('save-quote-dialog').click();
  await expect(page.getByTestId('quote-detail')).toBeVisible();
  const quotes = await idbAll<Row>(page, 'quotations');
  expect(quotes).toHaveLength(1);
  expect(quotes[0]?.status).toBe('open');
  expect(quotes[0]?.total).toBe(PRICE);
  expect(String(quotes[0]?.quote_no)).toMatch(/^QTN-A-\d+$/u);
  return String(quotes[0]?.id);
}

test.describe('Quotations (v1.2)', () => {
  test('AC 1–3, 6, 13, 14: create, share, print and convert in English and Urdu', async ({
    page,
  }) => {
    for (const locale of LOCALES) {
      const quoteId = await createQuote(page, locale);
      await expect(page.getByTestId('quote-status')).toBeVisible();
      if ((page.viewportSize()?.width ?? 1280) < 1024)
        await expect(page.getByTestId('topbar-back')).toBeVisible();
      else await expect(page.getByTestId('quote-back')).toBeVisible();
      await expect(page.getByTestId('quote-total')).toContainText('42,000');
      await expect(page.getByTestId('quote-not-invoice')).toBeVisible();
      await expectNoHorizontalScroll(page);

      // A quotation is not a sale: no money, stock or ledger rows yet.
      expect(await idbAll(page, 'sales')).toHaveLength(0);
      expect(await idbAll(page, 'payments')).toHaveLength(0);
      expect(await idbAll(page, 'ledger_entries')).toHaveLength(0);
      expect(
        (await idbAll<Row>(page, 'stock_movements')).filter(
          (row) => row.reason_code !== 'opening',
        ),
      ).toHaveLength(0);
      expect(await idbAll(page, 'quotation_lines')).toHaveLength(1);

      // Share uses the OS share sheet with the quotation text.
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'canShare', {
          configurable: true,
          value: () => true,
        });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async (data: ShareData) => {
            (window as unknown as { __shared?: ShareData }).__shared = data;
          },
        });
      });
      await page.getByTestId('share-quote').click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __shared?: ShareData }).__shared?.text ??
              '',
          ),
        )
        .toContain('QUOTATION');
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __shared?: ShareData }).__shared?.text ??
              '',
          ),
        )
        .toContain('not a tax invoice');
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __shared?: ShareData }).__shared?.files
                ?.length ?? 0,
          ),
        )
        .toBe(1);

      const [pdfFile] = await Promise.all([
        page.waitForEvent('download'),
        detailAction(page, 'pdf-quote', /PDF/u),
      ]);
      const pdfBytes = await readFile((await pdfFile.path()) ?? '');
      expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');

      await detailAction(page, 'print-quote', /Print|پرنٹ/u);
      await expect
        .poll(async () => {
          const jobs = await idbAll<Row>(page, 'print_jobs');
          return jobs.filter((job) => job.kind === 'quotation').length;
        })
        .toBeGreaterThan(0);

      await page.getByTestId('convert-quote').click();
      await expect(page).toHaveURL(/\/sell/u);
      await openCart(page);
      await expect(page.getByTestId('quote-convert-banner')).toBeVisible();
      await page.keyboard.press('F8');
      const pay = page.getByRole('dialog');
      await expect(pay.getByTestId('pay-done')).toBeVisible();
      await pay.getByTestId('pay-done').click();
      const done = page.getByRole('dialog');
      await expect(done.getByTestId('sale-saved')).toBeVisible();
      await done.getByRole('button', { name: /Open bill|بل کھولیں/u }).click();
      await expect(page.getByTestId('bill-status')).toBeVisible();
      await expect(page.getByTestId('bill-from-quote')).toBeVisible();

      const quotes = await idbAll<Row>(page, 'quotations');
      const converted = quotes.find((row) => row.id === quoteId);
      expect(converted?.status).toBe('converted');
      const sales = await idbAll<Row>(page, 'sales');
      expect(sales).toHaveLength(1);
      expect(await idbAll(page, 'payments')).toHaveLength(1);
      await expect(
        page.getByTestId('bill-from-quote').getByRole('link'),
      ).toHaveText(String(converted?.quote_no));
      await page.evaluate(
        (id) => window.__bikriTest?.navigate(`/quotations/${id}`),
        quoteId,
      );
      await expect(page.getByTestId('quote-converted-banner')).toContainText(
        String(sales[0]?.invoice_no),
      );
      await expect(
        page.getByTestId('quote-converted-banner').getByRole('link'),
      ).toHaveText(String(sales[0]?.invoice_no));
      await page.evaluate(() => window.__bikriTest?.navigate('/quotations'));
      const [listCsv] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('export-quotes').click(),
      ]);
      const csv = await readFile((await listCsv.path()) ?? '', 'utf8');
      expect(csv).toContain('quote_no,date,valid_until,customer,phone');
      expect(csv).toContain(String(converted?.quote_no));
      await expectNoHorizontalScroll(page);
    }
  });

  test('cancelling the Save quote dialog leaves the cart in normal sale mode', async ({
    page,
  }) => {
    await openReadyShop(page, '/bikri/sell');
    await page.evaluate(
      (list) => window.__bikriTest?.seedProducts(list),
      [{ name: PRODUCT, price: PRICE, cost: 3_800_000, stock: 10 }],
    );
    await expect(tile(page)).toBeVisible();
    await tile(page).click();
    await openCart(page);
    await page.getByTestId('save-quote').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Cancel|منسوخ/u }).click();
    const carts = await idbAll<Row>(page, 'carts');
    const cart = carts.find((row) => (row.lines as Row[]).length === 1);
    expect(cart?.quote ?? null).toBeNull();
    await openCart(page);
    await expect(page.getByTestId('save-quote')).toBeVisible();
    await expect(page.getByTestId('quote-banner')).toHaveCount(0);
  });

  test('AC 8, 9: an expired quote re-prices, keeps quoted prices with approval and duplicates', async ({
    page,
  }) => {
    for (const locale of LOCALES) {
      const quoteId = await createQuote(page, locale);
      await idbUpdate(page, 'quotations', quoteId, {
        valid_until: '2020-01-01',
      });
      await page.evaluate(
        ([product, price]) => {
          const open = indexedDB.open(
            `bikri-${localStorage.getItem('bikri.active_tenant') ?? 'dev'}`,
          );
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('products', 'readwrite');
            const store = tx.objectStore('products');
            const all = store.getAll();
            all.onsuccess = () => {
              for (const row of all.result)
                if (row.name_en === product) store.put({ ...row, price });
            };
            tx.oncomplete = () => db.close();
          };
        },
        [PRODUCT, NEW_PRICE] as const,
      );
      await page.reload();
      await expect(page.getByTestId('quote-detail')).toBeVisible();
      await page.getByTestId('convert-quote').click();
      await page.getByTestId('convert-today').click();
      await expect(page).toHaveURL(/\/sell/u);
      const carts = await idbAll<Row>(page, 'carts');
      const todayCart = carts.find(
        (cart) => (cart.quote as Row | null)?.mode === 'convert',
      );
      const lines = (todayCart?.lines ?? []) as Row[];
      expect(lines.find((line) => line.product_id !== null)?.unit_price).toBe(
        NEW_PRICE,
      );

      // Use the quoted price with owner approval (the dev shop's owner has catalog.edit).
      await page.evaluate(
        (id) => window.__bikriTest?.navigate(`/quotations/${id}`),
        quoteId,
      );
      await expect(page.getByTestId('quote-detail')).toBeVisible();
      await page.getByTestId('convert-quote').click();
      await page.getByTestId('use-quoted').click();
      await expect(page).toHaveURL(/\/sell/u);
      const quotedCarts = await idbAll<Row>(page, 'carts');
      const quotedCart = quotedCarts.find(
        (cart) =>
          (cart.quote as Row | null)?.mode === 'convert' &&
          cart.id !== todayCart?.id,
      );
      const quotedLines = (quotedCart?.lines ?? []) as Row[];
      expect(
        quotedLines.find((line) => line.product_id !== null)?.unit_price,
      ).toBe(PRICE);
      expect(
        (await idbAll<Row>(page, 'audit_log')).filter(
          (row) => row.action === 'quote_expired_price_used',
        ),
      ).toHaveLength(1);

      // Duplicate opens a new, unsaved quote with the same lines.
      await page.evaluate(
        (id) => window.__bikriTest?.navigate(`/quotations/${id}`),
        quoteId,
      );
      await page.getByTestId('page-actions-more').click();
      await page.getByRole('button', { name: /Duplicate|نقل/u }).click();
      await expect(page).toHaveURL(/\/sell/u);
      await openCart(page);
      const copyCarts = await idbAll<Row>(page, 'carts');
      const copy = copyCarts.find(
        (cart) => (cart.quote as Row | null)?.mode === 'new',
      );
      expect(copy?.quote).toMatchObject({ quote_id: null, quote_no: null });
      await openCart(page);
      await page.getByTestId('save-quote').click();
      await page.getByTestId('save-quote-dialog').click();
      await expect(page.getByTestId('quote-detail')).toBeVisible();
      expect(await idbAll(page, 'quotations')).toHaveLength(2);
    }
  });
});
