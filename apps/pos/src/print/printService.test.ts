import { createFakeRasterRenderer, paperRuler } from '@bikri/printer';
import { afterEach, describe, expect, it } from 'vitest';
import {
  logDrawerOpen,
  type PrinterKv,
  queueSalePrint,
} from '../data/receipt.ts';
import { completeSale } from '../data/sale.ts';
import { dropTestDbs } from '../data/testDb.ts';
import { addShop, NOW, sale, shopWithStock, t2Cart } from '../data/testShop.ts';
import { fakeSerial, fakeUsb, joined } from './fakePrinters.ts';
import {
  kickDrawer,
  type PrintDeps,
  printTestPage,
  processQueue,
  runJob,
} from './printService.ts';
import { chunks, PrintError, withTimeout } from './transports.ts';

afterEach(dropTestDbs);

const usbPrinter = (extra: PrinterKv = {}): PrinterKv => ({
  transport: 'usb',
  paper_mm: 80,
  usb: { vendorId: 0x0416, productId: 0x5011, serialNumber: 'P1' },
  ...extra,
});
const serialPrinter = (extra: PrinterKv = {}): PrinterKv => ({
  transport: 'serial',
  paper_mm: 80,
  serial: {
    usbVendorId: 0x1a86,
    usbProductId: 0x7523,
    baudRate: 9600,
    flowControl: 'none',
  },
  ...extra,
});

async function soldShop(
  prefix: string,
  rows = [{ method: 'cash' as const, amount: 5000000 }],
) {
  const fx = await shopWithStock(prefix);
  await addShop(fx.db);
  const input = sale(t2Cart(fx.phone, fx.buds), rows, { print: true });
  await completeSale(fx.db, input, fx.ctx, NOW);
  return { ...fx, saleId: input.saleId };
}

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const latin = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const DRAWER = '1b 70 00 19 fa';
const renderer = createFakeRasterRenderer();

describe('transports (06 §10)', () => {
  it('USB and Serial send identical bytes for the same job at 48 and 32 chars/line', async () => {
    for (const paper_mm of [80, 58] as const) {
      const { db } = await soldShop(`ps${paper_mm}`);
      const usb = fakeUsb();
      const serial = fakeSerial();
      const deps: PrintDeps = { usb, serial, renderer };
      const [job] = await db.print_jobs.toArray();
      if (!job) throw new Error('no job');
      await db.kv.put({ key: 'printer', value: usbPrinter({ paper_mm }) });
      expect(await runJob(db, job, deps)).toMatchObject({ status: 'done' });
      await db.kv.put({ key: 'printer', value: serialPrinter({ paper_mm }) });
      await runJob(db, job, deps);
      const a = joined(usb.device.sent);
      const b = joined(serial.port.sent);
      expect(a.length).toBeGreaterThan(200);
      expect(hex(a)).toBe(hex(b));
      const text = latin(a);
      expect(text).toContain('SALE RECEIPT');
      expect(text).toContain('A-A-1');
      expect(hex(a)).toContain(DRAWER);
      expect(serial.port.openedWith).toMatchObject({
        baudRate: 9600,
        flowControl: 'none',
      });
      // test page ruler fits exactly chars_per_line
      usb.device.sent.length = 0;
      await printTestPage(db, usbPrinter({ paper_mm }), deps);
      const chars = paper_mm === 80 ? 48 : 32;
      expect(latin(joined(usb.device.sent))).toContain(paperRuler(chars));
      expect(latin(joined(usb.device.sent))).not.toContain(
        paperRuler(chars + 1),
      );
    }
  });

  it('keeps the setup test page in text mode for an Urdu shop', async () => {
    const { db } = await soldShop('psTestUr');
    await db.shop.update('shop', { receipt_language: 'ur' });
    const usb = fakeUsb();
    await printTestPage(db, usbPrinter(), { usb, serial: null, renderer });
    expect(latin(joined(usb.device.sent))).toContain(paperRuler(48));
  });

  it('chunks USB writes at 4096 bytes', async () => {
    const big = new Uint8Array(10_000).fill(7);
    expect(chunks(big).map((c) => c.length)).toEqual([4096, 4096, 1808]);
    const { db } = await soldShop('psChunk');
    await db.kv.put({
      key: 'logo_bitmap',
      value: {
        width: 576,
        height: 160,
        data: new Uint8Array(576 * 160),
        format: 'gray',
      },
    });
    const usb = fakeUsb();
    await printTestPage(db, usbPrinter(), { usb, serial: null, renderer });
    expect(usb.device.sent.length).toBeGreaterThan(1);
    expect(usb.device.sent.every((c) => c.length <= 4096)).toBe(true);
  });

  it('timeout → TIMEOUT; claim refused → PERMISSION; cable out → DISCONNECTED; the sale is kept', async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 10),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    const { db, saleId } = await soldShop('psFail');
    await db.kv.put({ key: 'printer', value: usbPrinter() });
    const [job] = await db.print_jobs.toArray();
    if (!job) throw new Error('no job');
    const usb = fakeUsb();
    usb.device.hang = true;
    expect(
      await runJob(db, job, { usb, serial: null, timeoutMs: 20 }),
    ).toMatchObject({ status: 'failed', error: 'TIMEOUT' });
    const refused = fakeUsb();
    refused.device.claimFail = 'SecurityError';
    expect(await runJob(db, job, { usb: refused, serial: null })).toMatchObject(
      { error: 'PERMISSION' },
    );
    const pulled = fakeUsb();
    pulled.device.fail = 'NotFoundError';
    expect(await runJob(db, job, { usb: pulled, serial: null })).toMatchObject({
      error: 'DISCONNECTED',
    });
    expect(await db.print_jobs.get(job.id)).toMatchObject({
      status: 'failed',
      error: 'DISCONNECTED',
    });
    expect(await db.sales.get(saleId)).toMatchObject({
      status: 'paid',
      total: 4300000,
    });
    expect(await db.payments.where('sale_id').equals(saleId).count()).toBe(1);
    // no device granted / no WebUSB at all / no printer set up
    const none = { ...fakeUsb(), getDevices: async () => [] };
    expect(await runJob(db, job, { usb: none, serial: null })).toMatchObject({
      error: 'DISCONNECTED',
    });
    expect(await runJob(db, job, { usb: null, serial: null })).toMatchObject({
      error: 'UNSUPPORTED',
    });
    await db.kv.delete('printer');
    expect(await runJob(db, job, { usb, serial: null })).toMatchObject({
      error: 'NO_PRINTER',
    });
    expect(new PrintError('FAILED').message).toBe('FAILED');
  });

  it('a vendor-class printer (0xFF) uses its first bulk OUT endpoint', async () => {
    const { db } = await soldShop('psVendor');
    const usb = fakeUsb({ interfaceClass: 0xff });
    await printTestPage(db, usbPrinter(), { usb, serial: null, renderer });
    expect(usb.device.sent.length).toBeGreaterThan(0);
  });
});

describe('print queue (06 §9)', () => {
  it('waits for a printer, then prints oldest first; reprints never open the drawer', async () => {
    const { db, saleId } = await soldShop('psQueue');
    const reprint = await queueSalePrint(db, saleId, {
      reprint: true,
      now: NOW + 1000,
    });
    const usb = fakeUsb();
    const seen: string[] = [];
    await processQueue(db, { usb, serial: null }, (j) => seen.push(j.id));
    expect(seen).toEqual([]);
    expect(await db.print_jobs.where('status').equals('queued').count()).toBe(
      2,
    );
    await db.kv.put({ key: 'printer', value: usbPrinter({ copies: 1 }) });
    await processQueue(db, { usb, serial: null }, (j) => seen.push(j.id));
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(reprint);
    expect(
      (await db.print_jobs.toArray()).every((j) => j.status === 'done'),
    ).toBe(true);
    // second job (reprint) alone
    usb.device.sent.length = 0;
    const job = await db.print_jobs.get(reprint);
    if (!job) throw new Error('no job');
    await runJob(db, job, { usb, serial: null });
    const bytes = joined(usb.device.sent);
    expect(latin(bytes)).toContain('REPRINT');
    expect(hex(bytes)).not.toContain(DRAWER);
  });

  it('card-only sale: no drawer; copies repeat the receipt; system printing gets the HTML', async () => {
    const { db } = await soldShop('psCard', [
      { method: 'card', amount: 4300000 },
    ] as never);
    const [job] = await db.print_jobs.toArray();
    if (!job) throw new Error('no job');
    const usb = fakeUsb();
    await db.kv.put({ key: 'printer', value: usbPrinter({ copies: 2 }) });
    await runJob(db, job, { usb, serial: null });
    const text = latin(joined(usb.device.sent));
    expect(text.split('SALE RECEIPT')).toHaveLength(3);
    expect(hex(joined(usb.device.sent))).not.toContain(DRAWER);
    const pages: string[] = [];
    await db.kv.put({
      key: 'printer',
      value: { transport: 'system', paper_mm: 58 },
    });
    await db.kv.put({
      key: 'logo_bitmap',
      value: { width: 4, height: 2, data: new Uint8Array(8), format: 'gray' },
    });
    expect(
      await runJob(db, job, {
        usb: null,
        serial: null,
        logoUrl: () => 'data:image/png;base64,AA==',
        system: async (html, w) => {
          pages.push(`${w}:${html}`);
          return { ok: true };
        },
      }),
    ).toMatchObject({ status: 'done' });
    expect(pages[0]?.startsWith('58:')).toBe(true);
    expect(pages[0]).toContain('SALE RECEIPT');
    expect(pages[0]).toContain('data:image/png;base64,AA==');
    expect(
      await runJob(db, job, {
        usb: null,
        serial: null,
        system: async () => ({ ok: false, code: 'NO_PRINT' }),
      }),
    ).toMatchObject({ error: 'UNSUPPORTED' });
    expect(
      await runJob(db, job, {
        usb: null,
        serial: null,
        system: async () => ({ ok: false, code: 'TIMEOUT' }),
      }),
    ).toMatchObject({ error: 'TIMEOUT' });
  });

  it('Urdu receipts are rasterised (GS v 0)', async () => {
    const { db } = await soldShop('psUrdu');
    await db.shop.update('shop', { receipt_language: 'ur' });
    await db.kv.put({ key: 'printer', value: serialPrinter() });
    const serial = fakeSerial();
    const [job] = await db.print_jobs.toArray();
    if (!job) throw new Error('no job');
    await runJob(db, job, {
      usb: null,
      serial,
      renderer: createFakeRasterRenderer(),
    });
    expect(hex(joined(serial.port.sent))).toContain('1d 76 30');
  });

  it('drawer kick: bytes, audit row, not over system printing', async () => {
    const { db, ctx } = await soldShop('psDrawer');
    const usb = fakeUsb();
    await kickDrawer(db, usbPrinter({ drawer_pin: 5 }), { usb, serial: null });
    expect(hex(joined(usb.device.sent))).toContain('1b 70 01 19 fa');
    await expect(
      kickDrawer(db, { transport: 'system' }, { usb, serial: null }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(
      kickDrawer(db, null, { usb, serial: null }),
    ).rejects.toMatchObject({ code: 'NO_PRINTER' });
    await logDrawerOpen(
      db,
      { device_id: ctx.device_id, staff_id: 'st-1' },
      NOW,
    );
    const audit = await db.audit_log.toArray();
    expect(audit.filter((a) => a.action === 'drawer_open')).toHaveLength(1);
  });

  it('isolation: a shop’s queue never prints another shop’s jobs', async () => {
    const a = await soldShop('psIsoA');
    const b = await soldShop('psIsoB');
    await b.db.print_jobs.clear();
    await b.db.kv.put({ key: 'printer', value: usbPrinter() });
    const usb = fakeUsb();
    await processQueue(b.db, { usb, serial: null });
    expect(usb.device.sent).toEqual([]);
    expect(await a.db.print_jobs.where('status').equals('queued').count()).toBe(
      1,
    );
    await a.db.kv.put({ key: 'printer', value: usbPrinter() });
    await processQueue(a.db, { usb, serial: null });
    expect(await a.db.print_jobs.where('status').equals('done').count()).toBe(
      1,
    );
    expect(await b.db.print_jobs.count()).toBe(0);
  });
});
