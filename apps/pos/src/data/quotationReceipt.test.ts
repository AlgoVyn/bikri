import {
  buildQuotationReceipt,
  renderReceiptText,
  resolvePaper,
} from '@bikri/printer';
import { afterEach, describe, expect, it } from 'vitest';
import { jobReceipt } from '../print/receiptFiles.ts';
import { addBundle, emptyCart, shopMoney } from './cart.ts';
import { saveNewProduct } from './catalog.ts';
import { loadQuotationReceipt } from './quotationReceipt.ts';
import { saveQuote } from './quotes.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, shopWithStock, t2Cart } from './testShop.ts';

afterEach(dropTestDbs);

describe('quotation receipt', () => {
  it('prints a quotation, not a tax invoice, with no payment rows', async () => {
    const fx = await shopWithStock('quote-paper');
    await addShop(fx.db);
    const money = shopMoney(await fx.db.shop.get('shop'));
    const cart = {
      ...t2Cart(fx.phone, fx.buds),
      quote: {
        quote_id: null,
        quote_no: null,
        valid_until: '2026-11-03',
        terms: '50% advance',
        mode: 'new' as const,
      },
    };
    await fx.db.carts.put(cart);
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart,
      money,
      validUntil: '2026-11-03',
      terms: '50% advance',
      staffId: 'st-1',
      now: NOW,
    });
    const job = {
      id: 'job-quote',
      quotation_id: quote.id,
      kind: 'quotation' as const,
      status: 'queued' as const,
      created_at: NOW,
    };
    const receipt = await jobReceipt(fx.db, job);
    expect(receipt).not.toBeNull();
    if (!receipt) return;
    const text = renderReceiptText(
      receipt.blocks,
      resolvePaper({ paperMm: 80 }),
    );
    expect(text).toContain('QUOTATION');
    expect(text).toContain('QTN-A-1');
    expect(text).toContain('Valid until');
    expect(text).toContain('not a tax invoice');
    expect(text).not.toMatch(/^Cash\b/mu);
    expect(text).not.toContain('Change');
    expect(text).toContain('Powered by AlgoVyn');
  });

  it('handles a missing quote, a deleted line, a deleted staff and a bundle snapshot', async () => {
    const fx = await shopWithStock('quote-receipt-branches');
    await addShop(fx.db, { receipt_language: 'ur' });
    const money = shopMoney(await fx.db.shop.get('shop'));
    const bundle = await saveNewProduct(
      fx.db,
      {
        name_en: 'Starter Pack',
        sku: 'QR-BND',
        unit: 'set',
        price: 700000,
        kind: 'bundle',
        track_stock: false,
        bundle_items: [
          { component_product_id: fx.phone.id, qty_milli: 1000 },
          { component_product_id: fx.buds.id, qty_milli: 1000 },
        ],
      },
      fx.ctx,
      { now: NOW },
    );
    let cart = addBundle(
      emptyCart('c1', NOW),
      bundle,
      [
        { product: fx.phone, qty_milli: 1000 },
        { product: fx.buds, qty_milli: 1000 },
      ],
      1,
      'avg',
    );
    cart = {
      ...cart,
      quote: {
        quote_id: null,
        quote_no: null,
        valid_until: '2026-11-03',
        terms: '',
        mode: 'new',
      },
    };
    await fx.db.carts.put(cart);
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart,
      money,
      validUntil: '2026-11-03',
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    await fx.db.quotations.update(quote.id, {
      customer_name: 'Ali',
      customer_phone: '+923001234567',
      tax_inclusive: 1,
    });
    await fx.db.staff.delete('st-1');
    const line = await fx.db.quotation_lines
      .where('quote_id')
      .equals(quote.id)
      .first();
    if (line) await fx.db.quotation_lines.update(line.id, { deleted_at: NOW });
    const loaded = await loadQuotationReceipt(fx.db, quote.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.quote.customerName).toBe('Ali');
    expect(loaded?.quote.staffName).toBeNull();
    expect(loaded?.lines.length).toBe(1);
    expect(loaded?.lines[0]?.bundlePrice).toBe(700000);
    expect(await loadQuotationReceipt(fx.db, 'missing')).toBeNull();
  });

  it('builds the same blocks directly from the quote input', async () => {
    const fx = await shopWithStock('quote-blocks');
    await addShop(fx.db);
    const money = shopMoney(await fx.db.shop.get('shop'));
    const cart = {
      ...t2Cart(fx.phone, fx.buds),
      quote: {
        quote_id: null,
        quote_no: null,
        valid_until: '2026-11-03',
        terms: '',
        mode: 'new' as const,
      },
    };
    await fx.db.carts.put(cart);
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart,
      money,
      validUntil: '2026-11-03',
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    const lines = await fx.db.quotation_lines
      .where('quote_id')
      .equals(quote.id)
      .toArray();
    const blocks = buildQuotationReceipt(
      {
        shop: {
          name: 'Bilal Mobile',
          address: 'Main Bazaar',
          phone: '+923001234567',
          receiptHeader: '',
          receiptFooter: '',
          showPaymentDetails: true,
          showCashierOnReceipt: true,
          taxLabel: 'Sales tax',
          numberGrouping: 'intl',
          ntn: '',
          strn: '',
          printWarranty: true,
          showYouSaved: true,
          timeZone: 'Asia/Karachi',
        },
        quote: {
          quoteNo: String(quote.quote_no),
          createdAt: NOW,
          businessDate: String(quote.business_date),
          validUntil: String(quote.valid_until),
          customerName: null,
          staffName: 'Adnan',
          itemsQtyMilli: Number(quote.items_qty_milli),
          itemDiscountTotal: Number(quote.item_discount_total),
          subtotal: Number(quote.subtotal),
          billDiscount: Number(quote.bill_discount),
          taxRateBp: 0,
          tax: 0,
          taxInclusive: false,
          rounding: Number(quote.rounding),
          total: Number(quote.total),
          note: '',
        },
        lines: lines.map((line) => ({
          name: String(line.name_snapshot),
          qtyMilli: Number(line.qty_milli),
          unitPrice: Number(line.unit_price),
          discount: Number(line.discount),
          net: Number(line.net),
          warrantyUntil: null,
        })),
      },
      { paperMm: 80 },
    );
    expect(
      blocks.some(
        (block) => block.t === 'text' && block.text.includes('QUOTATION'),
      ),
    ).toBe(true);
  });
});
