import { buildSaleReceipt, renderReceiptText } from '@bikri/printer';
import { afterEach, describe, expect, it } from 'vitest';
import { createCustomer } from './customers.ts';
import {
  latestSaleJob,
  loadSaleReceipt,
  queueSalePrint,
  receiptPaper,
  receiptShareText,
  retryPrintJob,
  waLink,
  waNumber,
} from './receipt.ts';
import { completeSale } from './sale.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, sale, shopWithStock, t2Cart } from './testShop.ts';

afterEach(dropTestDbs);

async function soldShop(prefix = 'rcpt', shop: Record<string, unknown> = {}) {
  const fx = await shopWithStock(prefix);
  await addShop(fx.db, shop);
  const input = sale(t2Cart(fx.phone, fx.buds), [
    { method: 'cash', amount: 5000000 },
  ]);
  await completeSale(fx.db, input, fx.ctx, NOW);
  return { ...fx, saleId: input.saleId };
}

const text = (input: Parameters<typeof buildSaleReceipt>[0]) =>
  renderReceiptText(buildSaleReceipt(input), {
    charsPerLine: 48,
    itemLayout: 'columns',
  });

describe('sale receipt from local rows (screens/07)', () => {
  it('builds the printer input: shop, bill, lines in added order, cash, cashier', async () => {
    const { db, saleId } = await soldShop();
    const r = await loadSaleReceipt(db, saleId);
    expect(r?.shop).toMatchObject({
      name: 'Bilal Mobile',
      phone: '+923001234567',
    });
    expect(r?.sale).toMatchObject({
      invoiceNo: 'A-A-1',
      total: 4300000,
      cashTendered: 5000000,
      changeGiven: 700000,
      udhaarAmount: 0,
      khataBalancePaisa: null,
      reprint: false,
      customerName: null,
    });
    expect(r?.lines.map((l) => [l.name, l.net, l.warrantyUntil])).toEqual([
      ['Galaxy A15', 4000000, '2027-10-27'],
      ['Earbuds', 350000, null],
    ]);
    expect(r?.payments).toEqual([
      { method: 'cash', amount: 4300000, reference: undefined },
    ]);
    expect(r?.staffName).toBe('Adnan');
    const out = text(r as NonNullable<typeof r>);
    expect(out).toContain('SALE RECEIPT');
    expect(out).toContain('A-A-1');
    expect(out).toContain('Powered by AlgoVyn');
    expect(out).not.toContain('REPRINT');
    expect(await loadSaleReceipt(db, 'nope')).toBeNull();
  });

  it('Urdu receipts print Urdu labels; Powered by AlgoVyn stays as is', async () => {
    const { db, saleId } = await soldShop('rcpt-ur', {
      receipt_language: 'ur',
    });
    const r = await loadSaleReceipt(db, saleId, { reprint: true });
    const out = text(r as NonNullable<typeof r>);
    expect(out).toContain('رسید');
    expect(out).toContain('دوبارہ پرنٹ');
    expect(out).toContain('کیشیئر');
    expect(out).not.toContain('SALE RECEIPT');
    expect(out).not.toContain('Cashier');
    expect(out).toContain('Powered by AlgoVyn');
  });

  it('AC 3: a reprint carries REPRINT right under the title', async () => {
    const { db, saleId } = await soldShop();
    const r = await loadSaleReceipt(db, saleId, { reprint: true });
    const rows = text(r as NonNullable<typeof r>)
      .split('\n')
      .map((l) => l.trim());
    const title = rows.indexOf('SALE RECEIPT');
    expect(title).toBeGreaterThan(-1);
    expect(rows[title + 1]).toBe('REPRINT');
  });

  it('udhaar part prints the khata balance; wallet provider and reference travel together', async () => {
    const fx = await shopWithStock('rcptU');
    await addShop(fx.db);
    const ali = await createCustomer(
      fx.db,
      { name: 'Ali', phone: '03001234567' },
      'st-1',
    );
    const input = sale({ ...t2Cart(fx.phone, fx.buds), customer_id: ali.id }, [
      { method: 'udhaar', amount: 300000 },
      {
        method: 'bank_wallet',
        amount: 4000000,
        provider: 'JazzCash',
        reference: 'TX9',
      },
    ]);
    await completeSale(fx.db, input, fx.ctx, NOW);
    const r = await loadSaleReceipt(fx.db, input.saleId);
    expect(r?.sale).toMatchObject({
      udhaarAmount: 300000,
      khataBalancePaisa: 300000,
      customerName: 'Ali',
    });
    expect(r?.payments).toEqual([
      { method: 'bank_wallet', amount: 4000000, reference: 'JazzCash TX9' },
    ]);
    const share = receiptShareText(r as NonNullable<typeof r>);
    expect(share).toContain('Bill A-A-1');
    expect(share).toContain('Udhaar Rs 3,000');
    expect(share).toContain('Khata balance now Rs 3,000');
    expect(share).toContain('Galaxy A15 × 1');
  });

  it('print jobs: queue, latest, retry', async () => {
    const { db, saleId } = await soldShop();
    const first = await queueSalePrint(db, saleId, { now: NOW });
    await db.print_jobs.update(first, { status: 'failed', error: 'NO_DEVICE' });
    const again = await queueSalePrint(db, saleId, {
      reprint: true,
      now: NOW + 1000,
    });
    expect(await latestSaleJob(db, saleId)).toMatchObject({
      id: again,
      reprint: true,
      status: 'queued',
    });
    await retryPrintJob(db, first);
    expect(await db.print_jobs.get(first)).toMatchObject({ status: 'queued' });
    expect(await latestSaleJob(db, 'other')).toBeUndefined();
  });

  it('isolation: one shop cannot load or reprint another shop’s bill', async () => {
    const a = await soldShop('rcptA');
    const b = await soldShop('rcptB', { name: 'Sana Store' });
    const bReceipt = await loadSaleReceipt(b.db, b.saleId);
    expect(bReceipt?.shop.name).toBe('Sana Store');
    expect(await loadSaleReceipt(b.db, a.saleId)).toBeNull();
    expect(await loadSaleReceipt(a.db, b.saleId)).toBeNull();
    await queueSalePrint(a.db, a.saleId);
    expect(await b.db.print_jobs.count()).toBe(0);
    expect(await latestSaleJob(b.db, a.saleId)).toBeUndefined();
  });
});

describe('share helpers', () => {
  it('normalises Pakistani numbers for wa.me', () => {
    expect(waNumber('0300-1234567')).toBe('923001234567');
    expect(waNumber('+92 300 1234567')).toBe('923001234567');
    expect(waNumber('00923001234567')).toBe('923001234567');
    expect(waNumber('3001234567')).toBe('923001234567');
    expect(waNumber('12345')).toBeNull();
    expect(waLink('03001234567', 'Bill A-A-1 · Rs 43,000')).toBe(
      'https://wa.me/923001234567?text=Bill%20A-A-1%20%C2%B7%20Rs%2043%2C000',
    );
    expect(waLink('', 'x')).toBeNull();
  });

  it('paper defaults to 80 mm and follows the printer setting', () => {
    expect(receiptPaper(null)).toMatchObject({
      paperMm: 80,
      charsPerLine: 48,
      dots: 576,
      qr: false,
    });
    expect(receiptPaper({ paper_mm: 58, qr: true })).toMatchObject({
      paperMm: 58,
      charsPerLine: 32,
      dots: 384,
      itemLayout: 'stacked',
      qr: true,
    });
  });
});
