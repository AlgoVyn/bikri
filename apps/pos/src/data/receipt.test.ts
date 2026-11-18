import { buildSaleReceipt, renderReceiptText } from '@bikri/printer';
import { afterEach, describe, expect, it } from 'vitest';
import { addBundle, emptyCart, setBundleDiscount } from './cart.ts';
import { ledgerContext, saveNewProduct } from './catalog.ts';
import { createCustomer } from './customers.ts';
import { retryPrintJob } from './printJobs.ts';
import {
  latestSaleJob,
  loadSaleReceipt,
  queueSalePrint,
  receiptPaper,
  receiptShareText,
  resolveReceiptLanguage,
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

describe('receipt language', () => {
  it('resolves "same as app" and explicit choices', () => {
    expect(resolveReceiptLanguage('app', 'ur')).toBe('ur');
    expect(resolveReceiptLanguage('app', 'en')).toBe('en');
    expect(resolveReceiptLanguage('app', 'roman-ur')).toBe('en');
    expect(resolveReceiptLanguage('ur', 'en')).toBe('ur');
    expect(resolveReceiptLanguage('en', 'ur')).toBe('en');
  });
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

  it('prints and shares the sale remark', async () => {
    const fx = await shopWithStock('rcpt-note');
    await addShop(fx.db);
    const input = sale(
      t2Cart(fx.phone, fx.buds),
      [{ method: 'cash', amount: 5000000 }],
      { note: 'Deliver after 6 pm' },
    );
    await completeSale(fx.db, input, fx.ctx, NOW);
    const r = await loadSaleReceipt(fx.db, input.saleId);
    expect(r?.sale.note).toBe('Deliver after 6 pm');
    expect(text(r as NonNullable<typeof r>)).toContain(
      'Remark: Deliver after 6 pm',
    );
    expect(receiptShareText(r as NonNullable<typeof r>)).toContain(
      'Remark: Deliver after 6 pm',
    );
  });

  it('prints one bundle header and its components without component prices', async () => {
    const fx = await shopWithStock('rcpt-bundle');
    await addShop(fx.db);
    const ctx = await ledgerContext(fx.db, 'st-1');
    const bundle = await saveNewProduct(
      fx.db,
      {
        name_en: 'Starter Pack',
        sku: 'RCPT-BND',
        unit: 'set',
        price: 4_000_000,
        kind: 'bundle',
        track_stock: false,
        bundle_items: [
          { component_product_id: fx.phone.id, qty_milli: 1000 },
          { component_product_id: fx.buds.id, qty_milli: 1000 },
        ],
      },
      ctx,
      { now: NOW },
    );
    let cart = addBundle(
      emptyCart('c1'),
      bundle,
      [
        { product: fx.phone, qty_milli: 1000 },
        { product: fx.buds, qty_milli: 1000 },
      ],
      2,
      'avg',
    );
    cart = setBundleDiscount(
      cart,
      String(cart.lines[0]?.bundle_group),
      'amount',
      50_000,
      new Map([
        [fx.phone.id, fx.phone],
        [fx.buds.id, fx.buds],
      ]),
      'avg',
    );
    const input = sale(cart, [{ method: 'cash', amount: 7_900_000 }], {
      saleId: 'sale-rcpt-bundle',
    });
    await completeSale(fx.db, input, fx.ctx, NOW);
    const loaded = await loadSaleReceipt(fx.db, input.saleId);
    expect(loaded?.lines.map((line) => line.bundleQty)).toEqual([2, 2]);
    expect(loaded?.lines[0]?.bundleName).toBe('Starter Pack');
    expect(loaded?.sale.bundleDiscount).toBe(100_000);
    const out = text(loaded as NonNullable<typeof loaded>);
    expect(out).not.toContain('Bundle:');
    expect(out).toContain('Starter Pack');
    expect(out).toContain('Galaxy A15');
    expect(out).toContain('Earbuds');
    expect(out).toContain('Rs 79,000');
  });

  it('falls back when a saved bundle snapshot has no name or price', async () => {
    const fx = await shopWithStock('rcpt-bundle-null');
    await addShop(fx.db);
    const ctx = await ledgerContext(fx.db, 'st-1');
    const bundle = await saveNewProduct(
      fx.db,
      {
        name_en: 'Null Pack',
        sku: 'RCPT-NULL',
        unit: 'set',
        price: 3_000_000,
        kind: 'bundle',
        track_stock: false,
        bundle_items: [
          { component_product_id: fx.phone.id, qty_milli: 1000 },
          { component_product_id: fx.buds.id, qty_milli: 1000 },
        ],
      },
      ctx,
      { now: NOW },
    );
    const cart = addBundle(
      emptyCart('c1'),
      bundle,
      [
        { product: fx.phone, qty_milli: 1000 },
        { product: fx.buds, qty_milli: 1000 },
      ],
      1,
      'avg',
    );
    const input = sale(cart, [{ method: 'cash', amount: 3_000_000 }], {
      saleId: 'sale-rcpt-null',
    });
    await completeSale(fx.db, input, fx.ctx, NOW);
    await fx.db.sale_lines.where('sale_id').equals(input.saleId).modify({
      bundle_name: null,
      bundle_qty: null,
      bundle_price: null,
      bundle_discount: null,
    });
    const loaded = await loadSaleReceipt(fx.db, input.saleId);
    expect(loaded?.sale.bundleDiscount).toBe(0);
    expect(loaded?.lines[0]?.bundleName).toBeNull();
    const out = text(loaded as NonNullable<typeof loaded>);
    expect(out).not.toContain('Bundle:');
    expect(out).toContain('Rs 30,000');
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

  it('credit part prints the ledger balance; wallet provider and reference travel together', async () => {
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
    expect(share).toContain('Credit (on ledger) Rs 3,000');
    expect(share).toContain('Ledger balance now Rs 3,000');
    expect(share).toContain('Galaxy A15 × 1');
    // The text share follows the receipt's show-shop-name setting.
    const hidden = {
      ...(r as NonNullable<typeof r>),
      shop: { ...(r as NonNullable<typeof r>).shop, showShopName: false },
    };
    expect(receiptShareText(hidden)).not.toContain(
      (r as NonNullable<typeof r>).shop.name,
    );
  });

  it('maps the shop logo switch into the receipt input', async () => {
    const shown = await soldShop('rcpt-logo-on');
    expect((await loadSaleReceipt(shown.db, shown.saleId))?.shop.showLogo).toBe(
      true,
    );
    const hidden = await soldShop('rcpt-logo-off', {
      show_logo_on_receipt: 0,
    });
    expect(
      (await loadSaleReceipt(hidden.db, hidden.saleId))?.shop.showLogo,
    ).toBe(false);
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
    // Landlines pass the digit check but cannot receive WhatsApp.
    expect(waNumber('042-35761234')).toBeNull();
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
      sendWidth: false,
      qr: true,
    });
    expect(
      receiptPaper({ paper_mm: 80, chars_per_line: 32, dots: 384 }),
    ).toMatchObject({
      paperMm: 80,
      printMm: 58,
      printWidthMm: 48,
      charsPerLine: 32,
      dots: 384,
      paperDots: 576,
      leftMarginDots: 96,
      sendWidth: true,
      itemLayout: 'stacked',
    });
    expect(
      receiptPaper({ paper_mm: 80, chars_per_line: 24, dots: 288 }),
    ).toMatchObject({
      paperMm: 80,
      printMm: 58,
      printWidthMm: 36,
      charsPerLine: 24,
      dots: 288,
      paperDots: 576,
      leftMarginDots: 144,
      sendWidth: true,
      itemLayout: 'stacked',
    });
  });
});
