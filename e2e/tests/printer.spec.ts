import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import {
  expectNoHorizontalScroll,
  idbAll,
  idbPut,
  installFakePrinters,
  openReadyShop,
  printedText,
  setLanguage,
} from './helpers.ts';

// T-020: transports + printer setup (06 §5, §8, §9; screens/17 Printer; screens/06 AC 6).

const ruler = (n: number) =>
  Array.from({ length: n }, (_, i) => String((i + 1) % 10)).join('');
const DRAWER_PIN2 = String.fromCharCode(0x1b, 0x70, 0x00, 0x19, 0xfa);
const USB_PRINTER = {
  transport: 'usb',
  paper_mm: 80,
  chars_per_line: 48,
  dots: 576,
  usb: {
    vendorId: 0x0416,
    productId: 0x5011,
    serialNumber: 'P1',
    name: 'POS-80',
  },
};

async function start(page: Page, path = '/bikri/settings/printer') {
  await installFakePrinters(page);
  await openReadyShop(page, path);
  await page.evaluate(() =>
    window.__bikriTest?.seedProducts([
      { name: 'Galaxy A15', price: 4200000, cost: 3800000, stock: 3 },
    ]),
  );
}

async function go(page: Page, to: string) {
  await page.evaluate((path) => window.__bikriTest?.navigate(path), to);
}

/** Sells Galaxy A15 for cash and waits for Sale complete. */
async function sell(page: Page) {
  await go(page, '/sell');
  await page.getByTestId('sell-tile').filter({ hasText: 'Galaxy A15' }).click();
  await page.keyboard.press('F8');
  await page.getByTestId('pay-done').click();
  await expect(page.getByTestId('sale-complete')).toBeVisible();
}

async function answerYes(page: Page) {
  for (const q of [
    'Did the ruler fit on one line?',
    'Is the Urdu line readable?',
    'Did the paper cut and the drawer open?',
  ])
    await page.getByRole('group', { name: q }).getByLabel('Yes').check();
}

test.describe('Printer (T-020)', () => {
  test('wizard: 80 mm over USB, test page fits 48 characters; sales print with the drawer kick; reprint', async ({
    page,
  }) => {
    await start(page);
    await expect(page.getByTestId('printer-summary')).toHaveText(
      'No printer set up on this device.',
    );
    await page.getByRole('button', { name: 'Set up printer' }).click();
    await expect(page.getByLabel('80 mm (recommended)')).toBeChecked();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Connect printer' }).click();
    await expect(page.getByTestId('printer-device')).toHaveText(
      'Connected: POS-80',
    );
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Test print' }).click();
    await expect(
      page.getByText('Test page sent to the printer.'),
    ).toBeVisible();
    const test1 = await printedText(page, 'usb');
    expect(test1).toContain('BIKRI TEST PRINT');
    expect(test1).toContain(ruler(48));
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      ),
    ).toEqual([]);
    await answerYes(page);
    await page.getByRole('button', { name: 'Save printer' }).click();
    await expect(page.getByTestId('printer-summary')).toHaveText(
      'POS-80 · 80 mm · 48 characters',
    );
    await expectNoHorizontalScroll(page);

    await sell(page);
    await expect(page.getByTestId('print-status')).toHaveText('Printed');
    const receipt = await printedText(page, 'usb');
    expect(receipt).toContain('SALE RECEIPT');
    expect(receipt).toContain('A-A-1');
    expect(receipt).toContain('Powered by AlgoVyn');
    expect(receipt).toContain(DRAWER_PIN2);
    await page.evaluate(() => {
      (window as unknown as { __printed: unknown[] }).__printed.length = 0;
    });
    await page.keyboard.press('p');
    await expect.poll(() => printedText(page, 'usb')).toContain('REPRINT');
    expect(await printedText(page, 'usb')).not.toContain(DRAWER_PIN2);
  });

  test('wizard: 58 mm over Serial fits 32 characters; "ruler did not fit" offers 42 characters on 80 mm', async ({
    page,
  }) => {
    await start(page);
    await page.getByRole('button', { name: 'Set up printer' }).click();
    await page.getByLabel('58 mm').check();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Serial / COM port').check();
    await page.getByRole('button', { name: 'Choose port' }).click();
    await expect(page.getByTestId('printer-device')).toHaveText('Port chosen');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Test print' }).click();
    await expect(
      page.getByText('Test page sent to the printer.'),
    ).toBeVisible();
    const text = await printedText(page, 'serial');
    expect(text).toContain(ruler(32));
    expect(text).not.toContain(ruler(33));
    await page
      .getByRole('group', { name: 'Did the ruler fit on one line?' })
      .getByLabel('No')
      .check();
    await expect(
      page.getByRole('button', { name: 'Use 42 characters' }),
    ).toHaveCount(0);
    await answerYes(page);
    await page.getByRole('button', { name: 'Save printer' }).click();
    await expect(page.getByTestId('printer-summary')).toHaveText(
      'Serial / COM port · 58 mm · 32 characters',
    );
    await sell(page);
    await expect(page.getByTestId('print-status')).toHaveText('Printed');
    expect(await printedText(page, 'serial')).toContain('SALE RECEIPT');

    // 80 mm: a ruler that wraps offers 42 characters / 512 dots.
    await go(page, '/settings/printer');
    await page.getByRole('button', { name: 'Set up printer' }).click();
    await page.getByLabel('80 mm (recommended)').check();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Test print' }).click();
    await page
      .getByRole('group', { name: 'Did the ruler fit on one line?' })
      .getByLabel('No')
      .check();
    await page.getByRole('button', { name: 'Use 42 characters' }).click();
    await page.getByRole('button', { name: 'Test print' }).click();
    await expect.poll(() => printedText(page, 'serial')).toContain(ruler(42));
    await answerYes(page);
    await page.getByRole('button', { name: 'Save printer' }).click();
    await expect(page.getByTestId('printer-summary')).toHaveText(
      'Serial / COM port · 80 mm · 42 characters',
    );
  });

  test('screens/06 AC 6: cable pulled before Done — sale saved, "Print failed — Retry", job in Recent prints', async ({
    page,
  }) => {
    await start(page, '/bikri/sell');
    await page.evaluate(async (printer) => {
      localStorage.setItem('fake-usb', '1');
      await window.__bikriTest?.setKv('printer', printer);
      (
        window as unknown as { __printerUnplugged: boolean }
      ).__printerUnplugged = true;
    }, USB_PRINTER);
    await sell(page);
    await expect(page.getByTestId('sale-saved')).toHaveText(
      'Sale saved · A-A-1',
    );
    await expect(
      page.getByText("Receipt didn't print — printer not connected"),
    ).toBeVisible();
    await expect(page.getByTestId('print-status')).toContainText(
      'Print failed',
    );
    expect(await idbAll(page, 'sales')).toHaveLength(1);
    await page.evaluate(() => {
      (
        window as unknown as { __printerUnplugged: boolean }
      ).__printerUnplugged = false;
    });
    await page
      .getByTestId('print-status')
      .getByRole('button', { name: 'Retry' })
      .click();
    await expect(page.getByTestId('print-status')).toHaveText('Printed');
    expect(await printedText(page)).toContain('SALE RECEIPT');
    await page.keyboard.press('Escape');
    await go(page, '/settings/printer');
    await expect(page.getByTestId('print-job').first()).toContainText(
      'Bill A-A-1',
    );
    await expect(page.getByTestId('print-job').first()).toContainText(
      'Printed',
    );
  });

  test('waiting print jobs can be cancelled', async ({ page }) => {
    await start(page);
    await idbPut(page, 'print_jobs', {
      id: 'job-wait',
      kind: 'sale',
      status: 'queued',
      created_at: Date.now(),
    });
    await page.reload();
    const job = page.getByTestId('print-job').filter({ hasText: 'Waiting' });
    await expect(job).toHaveCount(1);
    await job.getByRole('button', { name: 'Cancel print' }).click();
    await expect(job).toHaveCount(0);
    await expect(page.getByText('Print cancelled.')).toBeVisible();
  });

  test('F9 opens the drawer and is audited; a cashier is refused', async ({
    page,
  }) => {
    await start(page, '/bikri/sell');
    await page.evaluate(async (printer) => {
      localStorage.setItem('fake-usb', '1');
      await window.__bikriTest?.setKv('printer', printer);
    }, USB_PRINTER);
    await page.keyboard.press('F9');
    await expect(page.getByText('Drawer opened.')).toBeVisible();
    expect(await printedText(page)).toContain(DRAWER_PIN2);
    const audit = await idbAll<{ action: string }>(page, 'audit_log');
    expect(audit.filter((a) => a.action === 'drawer_open')).toHaveLength(1);
    await page.evaluate(() => window.__bikriTest?.unlockAs('cashier', 'Sana'));
    await page.keyboard.press('F9');
    await expect(
      page.getByText("You don't have permission to open the drawer."),
    ).toBeVisible();
    // Cashiers see the printer but cannot change it.
    await go(page, '/settings/printer');
    await expect(
      page.getByText('Ask the owner or a manager to change the printer.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Set up printer' }),
    ).toHaveCount(0);
  });

  test('Urdu: printer settings and wizard', async ({ page }) => {
    await start(page);
    await setLanguage(page, 'ur');
    await expect(
      page.getByRole('heading', { name: 'پرنٹر', level: 1 }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'پرنٹر سیٹ کریں' }).click();
    await page.getByRole('button', { name: 'آگے' }).click();
    await page.getByRole('button', { name: 'پرنٹر جوڑیں' }).click();
    await page.getByRole('button', { name: 'آگے' }).click();
    await page.getByRole('button', { name: 'ٹیسٹ پرنٹ' }).click();
    await expect(page.getByText('ٹیسٹ صفحہ پرنٹر کو بھیج دیا۔')).toBeVisible();
    await page.getByRole('button', { name: 'پرنٹر محفوظ کریں' }).click();
    await expect(page.getByTestId('printer-summary')).toContainText('POS-80');
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Print service agent (docs/14)', () => {
  test('pairs with the loopback agent, picks the queue and sends a raw ESC/POS test job', async ({
    page,
  }) => {
    let paired = false;
    let lastJob: Record<string, unknown> | null = null;
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-private-network': 'true',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    };
    await page.route('**/v1/**', async (route) => {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers: cors });
      const url = new URL(route.request().url());
      const json = (value: unknown, status = 200) =>
        route.fulfill({
          status,
          headers: { 'content-type': 'application/json', ...cors },
          body: JSON.stringify(value),
        });
      if (url.pathname === '/v1/health')
        return json({
          app: 'bikri-print-agent',
          version: '0.1.0-test',
          protocol: 1,
          platform: 'windows/amd64',
          paired,
          printers: 2,
          pairingCode: paired ? undefined : '123456',
        });
      if (url.pathname === '/v1/pair') {
        paired = true;
        return json({ token: 'test-token', agentId: 'agent-1' });
      }
      if (url.pathname === '/v1/printers')
        return json([
          { name: 'BIXOLON SRP-350III', isDefault: true },
          { name: 'Office PDF', isDefault: false },
        ]);
      if (url.pathname === '/v1/jobs' && route.request().method() === 'POST') {
        lastJob = JSON.parse(route.request().postData() ?? '{}') as Record<
          string,
          unknown
        >;
        return json({
          jobId: String(lastJob.jobId),
          status: 'done',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    });

    await openReadyShop(page, '/bikri/settings/printer');
    await page.getByRole('button', { name: 'Set up printer' }).click();
    await page.getByLabel('80 mm (recommended)').check();
    await page.getByRole('button', { name: 'Next' }).click();
    await page
      .getByRole('radio', { name: /Print service \(recommended\)/ })
      .check();
    await expect(page.getByLabel('Pairing code')).toHaveValue('123456');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(page.getByTestId('agent-printer')).toHaveValue(
      'BIXOLON SRP-350III',
    );
    await expect(
      page.getByRole('radio', { name: /^POS \(drawer and cut\)/ }),
    ).toBeChecked();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Test print' }).click();
    await expect(
      page.getByText('Test page sent to the printer.'),
    ).toBeVisible();
    expect(lastJob).toMatchObject({
      printer: 'BIXOLON SRP-350III',
      mode: 'raw',
      encoding: 'escpos',
      paperMm: 80,
      copies: 1,
    });
    await answerYes(page);
    await page.getByRole('button', { name: 'Save printer' }).click();
    await expect(page.getByTestId('printer-summary')).toHaveText(
      'BIXOLON SRP-350III · 80 mm · 48 characters',
    );
  });
});

test.describe('Print service agent compatibility mode (docs/14)', () => {
  test('sends a rendered PNG through the agent', async ({ page }) => {
    let paired = false;
    let lastJob: Record<string, unknown> | null = null;
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-private-network': 'true',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    };
    await page.route('**/v1/**', async (route) => {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers: cors });
      const url = new URL(route.request().url());
      const json = (value: unknown, status = 200) =>
        route.fulfill({
          status,
          headers: { 'content-type': 'application/json', ...cors },
          body: JSON.stringify(value),
        });
      if (url.pathname === '/v1/health')
        return json({
          app: 'bikri-print-agent',
          version: '0.1.0-test',
          protocol: 1,
          platform: 'windows/amd64',
          paired,
          printers: 1,
        });
      if (url.pathname === '/v1/pair') {
        paired = true;
        return json({ token: 'test-token', agentId: 'agent-1' });
      }
      if (url.pathname === '/v1/printers')
        return json([{ name: 'BIXOLON SRP-350III', isDefault: true }]);
      if (url.pathname === '/v1/jobs' && route.request().method() === 'POST') {
        lastJob = JSON.parse(route.request().postData() ?? '{}') as Record<
          string,
          unknown
        >;
        return json({
          jobId: String(lastJob.jobId),
          status: 'done',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    });

    await openReadyShop(page, '/bikri/settings/printer');
    await page.getByRole('button', { name: 'Set up printer' }).click();
    await page.getByLabel('80 mm (recommended)').check();
    await page.getByRole('button', { name: 'Next' }).click();
    await page
      .getByRole('radio', { name: /Print service \(recommended\)/ })
      .check();
    await page.getByLabel('Pairing code').fill('123456');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(page.getByTestId('agent-printer')).toHaveValue(
      'BIXOLON SRP-350III',
    );
    await page.getByRole('radio', { name: /^Compatibility/ }).check();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Test print' }).click();
    await expect(
      page.getByText('Test page sent to the printer.'),
    ).toBeVisible();
    const job = lastJob as Record<string, unknown> | null;
    expect(job?.printer).toBe('BIXOLON SRP-350III');
    expect(job?.mode).toBe('driver');
    expect(job?.encoding).toBe('png');
    expect(job?.paperMm).toBe(80);
    expect(String(job?.data ?? '').length).toBeGreaterThan(1000);
  });
});

test.describe('Print service agent install links (docs/14)', () => {
  test('shows platform downloads inside the wizard when the agent is not installed', async ({
    page,
  }) => {
    await page.route('**/v1/**', (route) => route.abort());
    await openReadyShop(page, '/bikri/settings/printer');
    await page.getByRole('button', { name: 'Set up printer' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page
      .getByRole('radio', { name: /Print service \(recommended\)/ })
      .check();
    await expect(
      page.getByText('Print service not found on this computer.'),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Windows 10/11 (installer)' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/AlgoVyn/bikri/releases/download/print-agent-v0.1.1/bikri-print-agent-setup.exe',
    );
    await expect(
      page.getByRole('link', { name: 'SHA-256 checksums' }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
