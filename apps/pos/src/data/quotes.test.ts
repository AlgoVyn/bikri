import { afterEach, describe, expect, it } from 'vitest';
import {
  addBundle,
  addQuickSale,
  emptyCart,
  removeLine,
  shopMoney,
  updateLine,
} from './cart.ts';
import { saveNewProduct } from './catalog.ts';
import { createCustomer } from './customers.ts';
import {
  cancelQuote,
  queueQuotePrint,
  quoteShareText,
  quoteStatus,
  quotesCsv,
  saveQuote,
  startNewQuote,
  startQuoteCart,
} from './quotes.ts';
import { completeSale } from './sale.ts';
import { dropTestDbs } from './testDb.ts';
import { addShop, NOW, sale, shopWithStock, t2Cart } from './testShop.ts';

afterEach(dropTestDbs);

const DAY = '2026-10-27';
const VALID = '2026-11-03';

async function quoteFixture(prefix = 'quote') {
  const fx = await shopWithStock(prefix);
  await addShop(fx.db);
  const money = shopMoney(await fx.db.shop.get('shop'));
  const cart = {
    ...t2Cart(fx.phone, fx.buds),
    quote: {
      quote_id: null,
      quote_no: null,
      valid_until: VALID,
      terms: '50% advance',
      mode: 'new' as const,
    },
  };
  await fx.db.carts.put(cart);
  return { ...fx, money, cart };
}

describe('quotes (D-305)', () => {
  it('saves a quote with its own number, lines and no stock or money rows', async () => {
    const fx = await quoteFixture('quote-save');
    const before = await fx.db.stock_levels.toArray();
    const result = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: '50% advance',
      staffId: 'st-1',
      now: NOW,
    });
    expect(result.created).toBe(true);
    expect(result.quote).toMatchObject({
      quote_no: 'QTN-A-1',
      quote_seq: 1,
      status: 'open',
      business_date: DAY,
      valid_until: VALID,
      total: 4300000,
      line_count: 2,
      note: '50% advance',
    });
    expect(
      await fx.db.quotation_lines
        .where('quote_id')
        .equals(result.quote.id)
        .count(),
    ).toBe(2);
    expect(await fx.db.stock_levels.toArray()).toEqual(before);
    expect(await fx.db.payments.count()).toBe(0);
    expect(await fx.db.ledger_entries.count()).toBe(0);
    expect(await fx.db.sales.count()).toBe(0);
    expect(await fx.db.kv.get('quote_seq')).toMatchObject({ value: 1 });
    expect((await fx.db.carts.get('c1'))?.lines).toEqual([]);
    const tables = new Set((await fx.db.outbox.toArray()).map((op) => op.tbl));
    expect(tables.has('quotations')).toBe(true);
    expect(tables.has('quotation_lines')).toBe(true);
    expect(tables.has('stock_movements')).toBe(false);
    expect(tables.has('payments')).toBe(false);
  });

  it('edits the quote in place and keeps its number', async () => {
    const fx = await quoteFixture('quote-edit');
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: 'old',
      staffId: 'st-1',
      now: NOW,
    });
    const editCart = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c2',
      mode: 'edit',
      now: NOW + 1000,
    });
    const firstLine = editCart.lines[0];
    if (!firstLine) throw new Error('missing line');
    const changed = updateLine(editCart, firstLine.key, { qty_milli: 2000 });
    await fx.db.carts.put(changed);
    const result = await saveQuote(fx.db, {
      cartId: 'c2',
      cart: changed,
      money: fx.money,
      validUntil: '2026-11-10',
      terms: 'new terms',
      staffId: 'st-1',
      now: NOW + 2000,
    });
    expect(result.created).toBe(false);
    expect(result.quote.id).toBe(quote.id);
    expect(result.quote.quote_no).toBe('QTN-A-1');
    expect(result.quote.note).toBe('new terms');
    expect(result.quote.valid_until).toBe('2026-11-10');
    expect(await fx.db.quotations.count()).toBe(1);
    expect(
      await fx.db.quotation_lines.where('quote_id').equals(quote.id).count(),
    ).toBe(2);
    const stored = await fx.db.quotation_lines
      .where('quote_id')
      .equals(quote.id)
      .toArray();
    expect(stored.find((line) => line.id === firstLine.key)?.qty_milli).toBe(
      2000,
    );
  });

  it('cancels an open quote without touching stock or money', async () => {
    const fx = await quoteFixture('quote-cancel');
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    const cancelled = await cancelQuote(fx.db, {
      quoteId: quote.id,
      reason: 'Customer declined',
      staffId: 'st-1',
      now: NOW + 1000,
    });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelled_reason: 'Customer declined',
    });
    await expect(
      cancelQuote(fx.db, {
        quoteId: quote.id,
        reason: 'again',
        staffId: 'st-1',
      }),
    ).rejects.toMatchObject({ code: 'terminal' });
  });

  it('converts a quote into a normal sale and marks it converted', async () => {
    const fx = await quoteFixture('quote-convert');
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    const convertCart = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c2',
      mode: 'convert',
      now: NOW + 1000,
    });
    const result = await completeSale(
      fx.db,
      sale(convertCart, [{ method: 'cash', amount: 4300000 }], {
        quoteId: quote.id,
        saleId: 'sale-quote-1',
      }),
      fx.ctx,
      NOW + 2000,
    );
    expect(result.created).toBe(true);
    expect(await fx.db.sales.get('sale-quote-1')).toMatchObject({
      invoice_no: 'A-A-1',
      total: 4300000,
    });
    expect(await fx.db.quotations.get(quote.id)).toMatchObject({
      status: 'converted',
      converted_sale_id: 'sale-quote-1',
    });
    expect(
      (await fx.db.audit_log.toArray()).filter(
        (row) => row.action === 'quote_convert',
      ).length,
    ).toBe(1);
  });

  it('derives open/expired/converted/cancelled status and exports a share CSV', async () => {
    expect(
      quoteStatus({ status: 'open', valid_until: '2026-10-26' }, DAY),
    ).toBe('expired');
    expect(quoteStatus({ status: 'open', valid_until: DAY }, DAY)).toBe('open');
    expect(quoteStatus({ status: 'converted', valid_until: DAY }, DAY)).toBe(
      'converted',
    );
    const csv = quotesCsv(
      [
        {
          quote_no: 'QTN-A-1',
          business_date: DAY,
          valid_until: VALID,
          customer_name: 'Ali',
          customer_phone: '+923001234567',
          items_qty_milli: 1000,
          subtotal: 100000,
          item_discount_total: 0,
          bill_discount: 0,
          tax: 0,
          total: 100000,
          status: 'open',
          staff_id: 'st-1',
          device_id: 'dev-1',
        },
      ],
      new Map([['st-1', 'Adnan']]),
      new Map([['dev-1', 'Counter 1']]),
    );
    expect(csv.split('\r\n')[0]).toBe(
      'quote_no,date,valid_until,customer,phone,items,subtotal,discounts,tax,total,status,staff,device',
    );
    expect(csv).toContain('QTN-A-1');
    const expired = quotesCsv(
      [
        {
          quote_no: 'QTN-A-2',
          business_date: DAY,
          valid_until: '2026-10-26',
          customer_name: 'Ali',
          customer_phone: '+923001234567',
          items_qty_milli: 1000,
          subtotal: 100000,
          item_discount_total: 0,
          bill_discount: 0,
          tax: 0,
          total: 100000,
          status: 'open',
          staff_id: 'st-1',
          device_id: 'dev-1',
        },
      ],
      new Map(),
      new Map(),
      DAY,
    );
    expect(expired).toContain(',expired,');
  });

  it('rejects invalid quote input and terminal transitions', async () => {
    const fx = await quoteFixture('quote-errors');
    const base = {
      cartId: 'c1' as const,
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW,
    };
    await expect(
      saveQuote(fx.db, { ...base, cart: { ...fx.cart, lines: [] } }),
    ).rejects.toMatchObject({ code: 'empty' });
    await expect(
      saveQuote(fx.db, { ...base, terms: 'x'.repeat(501) }),
    ).rejects.toMatchObject({ code: 'note' });
    await expect(
      saveQuote(fx.db, { ...base, validUntil: 'not-a-date' }),
    ).rejects.toMatchObject({ code: 'validity' });
    await expect(
      saveQuote(fx.db, { ...base, validUntil: '2026-10-26' }),
    ).rejects.toMatchObject({ code: 'validity' });
    await expect(
      saveQuote(fx.db, { ...base, validUntil: '2027-11-03' }),
    ).rejects.toMatchObject({ code: 'validity' });
    await expect(
      saveQuote(fx.db, {
        ...base,
        cart: {
          ...fx.cart,
          quote: {
            quote_id: 'missing',
            quote_no: 'QTN-A-9',
            valid_until: VALID,
            terms: '',
            mode: 'edit',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'missing' });
    await expect(
      startQuoteCart(fx.db, { quoteId: 'missing', cartId: 'c1', mode: 'edit' }),
    ).rejects.toMatchObject({ code: 'missing' });
    const line = fx.cart.lines[0];
    if (!line) throw new Error('missing line');
    await expect(
      saveQuote(fx.db, {
        ...base,
        cart: {
          ...fx.cart,
          lines: Array.from({ length: 61 }, (_, index) => ({
            ...line,
            key: `line-${index}`,
          })),
        },
      }),
    ).rejects.toMatchObject({ code: 'empty' });
    await expect(startNewQuote(fx.db, 'c1', NOW)).rejects.toMatchObject({
      code: 'changed',
    });
    await expect(
      cancelQuote(fx.db, { quoteId: 'missing', reason: 'x', staffId: 'st-1' }),
    ).rejects.toMatchObject({ code: 'missing' });
    const { quote } = await saveQuote(fx.db, { ...base, cart: fx.cart });
    await expect(
      cancelQuote(fx.db, {
        quoteId: quote.id,
        reason: 'x'.repeat(121),
        staffId: 'st-1',
      }),
    ).rejects.toMatchObject({ code: 'note' });
    const cancelled = await cancelQuote(fx.db, {
      quoteId: quote.id,
      reason: 'No',
      staffId: 'st-1',
      now: NOW + 1000,
    });
    expect(quoteStatus(cancelled, DAY)).toBe('cancelled');
    await expect(
      startQuoteCart(fx.db, {
        quoteId: quote.id,
        cartId: 'c2',
        mode: 'edit',
      }),
    ).rejects.toMatchObject({ code: 'terminal' });
  });

  it('uses a converter guard on a converted quote', async () => {
    const fx = await quoteFixture('quote-guard');
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    await fx.db.quotations.update(quote.id, {
      status: 'converted',
      converted_sale_id: 's1',
      converted_at: NOW,
    });
    await expect(
      startQuoteCart(fx.db, {
        quoteId: quote.id,
        cartId: 'c2',
        mode: 'convert',
      }),
    ).rejects.toMatchObject({ code: 'terminal' });
    await expect(
      startQuoteCart(fx.db, {
        quoteId: quote.id,
        cartId: 'c3',
        mode: 'edit',
      }),
    ).rejects.toMatchObject({ code: 'terminal' });
  });

  it('removes a line on edit and supports a normal cart and empty CSV maps', async () => {
    const fx = await quoteFixture('quote-remove');
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    const editCart = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c2',
      mode: 'edit',
      now: NOW + 1000,
    });
    const removed = removeLine(editCart, editCart.lines[0]?.key ?? '');
    await fx.db.carts.put(removed);
    const result = await saveQuote(fx.db, {
      cartId: 'c2',
      cart: removed,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW + 2000,
    });
    const active = await fx.db.quotation_lines
      .where('quote_id')
      .equals(quote.id)
      .filter((line) => line.deleted_at === null)
      .count();
    expect(active).toBe(1);
    expect(result.quote.line_count).toBe(1);

    const normal = {
      ...t2Cart(fx.phone, fx.buds),
      id: 'c3' as const,
    };
    await fx.db.carts.put(normal);
    const second = await saveQuote(fx.db, {
      cartId: 'c3',
      cart: normal,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW + 3000,
    });
    expect(second.quote.quote_no).toBe('QTN-A-2');
    expect(quotesCsv([], new Map(), new Map()).split('\r\n')).toHaveLength(1);
    expect(
      quoteShareText(
        { id: 'q', quote_no: 'Q', valid_until: VALID, total: 100 } as never,
        [],
        'Shop',
      ),
    ).toContain('Shop');
  });

  it('rejects an edit of a cancelled quote and a stale cart', async () => {
    const fx = await quoteFixture('quote-terminal');
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    await cancelQuote(fx.db, {
      quoteId: quote.id,
      reason: 'No',
      staffId: 'st-1',
      now: NOW + 1000,
    });
    const terminalCart = {
      ...fx.cart,
      id: 'c2' as const,
      quote: {
        quote_id: quote.id,
        quote_no: String(quote.quote_no),
        valid_until: VALID,
        terms: '',
        mode: 'edit' as const,
      },
    };
    await fx.db.carts.put(terminalCart);
    await expect(
      saveQuote(fx.db, {
        cartId: 'c2',
        cart: terminalCart,
        money: fx.money,
        validUntil: VALID,
        terms: '',
        staffId: 'st-1',
        now: NOW + 2000,
      }),
    ).rejects.toMatchObject({ code: 'terminal' });

    const stale = { ...fx.cart, id: 'c3' as const };
    await fx.db.carts.put({ ...stale, lines: [] });
    await expect(
      saveQuote(fx.db, {
        cartId: 'c3',
        cart: stale,
        money: fx.money,
        validUntil: VALID,
        terms: '',
        staffId: 'st-1',
        now: NOW + 3000,
      }),
    ).rejects.toMatchObject({ code: 'changed' });
  });

  it('snapshots a customer, a quick-sale line and a percentage bill discount', async () => {
    const fx = await quoteFixture('quote-lines');
    const customer = await createCustomer(
      fx.db,
      { name: 'Ali Traders', phone: '+923001112223' },
      'st-1',
      NOW,
    );
    let cart = addQuickSale(t2Cart(fx.phone, fx.buds), {
      name: 'Repair labour',
      price: 50000,
      qtyMilli: 1000,
    });
    cart = {
      ...cart,
      customer_id: customer.id,
      bill_discount: { type: 'percent', value: 500 },
      quote: {
        quote_id: null,
        quote_no: null,
        valid_until: VALID,
        terms: '',
        mode: 'new',
      },
    };
    await fx.db.carts.put(cart);
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    expect(quote.customer_name).toBe('Ali Traders');
    expect(quote.customer_phone).toBe('+923001112223');
    expect(quote.bill_discount_type).toBe('pct');
    await fx.db.carts.put(emptyCart('c2', NOW));
    const fresh = await startNewQuote(fx.db, 'c2', NOW);
    expect(fresh.quote?.mode).toBe('new');
    const load = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c1',
      mode: 'edit',
      now: NOW + 1000,
    });
    expect(load.lines.some((line) => line.product_id === null)).toBe(true);
    expect(load.customer_id).toBe(customer.id);
    expect(quotesCsv([{}], new Map(), new Map())).toContain('quote_no');
  });

  it('round-trips a bundle quote snapshot', async () => {
    const fx = await quoteFixture('quote-bundle');
    const bundle = await saveNewProduct(
      fx.db,
      {
        name_en: 'Starter Pack',
        sku: 'Q-BND',
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
        valid_until: VALID,
        terms: 'Bundle terms',
        mode: 'new',
      },
    };
    await fx.db.carts.put(cart);
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart,
      money: fx.money,
      validUntil: VALID,
      terms: 'Bundle terms',
      staffId: 'st-1',
      now: NOW,
    });
    const lines = await fx.db.quotation_lines
      .where('quote_id')
      .equals(quote.id)
      .toArray();
    expect(lines.every((line) => line.bundle_id === bundle.id)).toBe(true);
    expect(lines.every((line) => line.bundle_group)).toBe(true);
    const loaded = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c2',
      mode: 'edit',
      now: NOW + 1000,
    });
    expect(loaded.lines.every((line) => line.bundle_id === bundle.id)).toBe(
      true,
    );
    expect(loaded.lines[0]?.bundle_price).toBe(700000);

    // An expired conversion at today's prices follows the current bundle shelf price.
    await fx.db.products.update(bundle.id, { price: 750000, updated_at: NOW });
    const repriced = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c3',
      mode: 'convert',
      pricing: 'today',
      now: NOW + 10 * 86_400_000,
    });
    expect(repriced.lines[0]?.bundle_base_price).toBe(750000);
    expect(repriced.lines[0]?.bundle_price).toBe(750000);
  });

  it("re-prices an expired quote at today's catalogue and audits quoted prices", async () => {
    const fx = await quoteFixture('quote-reprice');
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: DAY,
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    await fx.db.products.update(fx.phone.id, {
      price: 4500000,
      updated_at: NOW,
    });
    const today = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c2',
      mode: 'convert',
      pricing: 'today',
      now: NOW + 3 * 86_400_000,
    });
    expect(
      today.lines.find((line) => line.product_id === fx.phone.id)?.unit_price,
    ).toBe(4500000);
    const quoted = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c3',
      mode: 'convert',
      pricing: 'quoted',
      approvedBy: 'st-1',
      staffId: 'st-1',
      now: NOW + 4 * 86_400_000,
    });
    expect(
      quoted.lines.find((line) => line.product_id === fx.phone.id)?.unit_price,
    ).toBe(4200000);
    expect(
      quoted.overrides?.some(
        (override) =>
          override.permission === 'catalog.edit' &&
          override.approved_by === 'st-1',
      ),
    ).toBe(true);
    expect(
      (await fx.db.audit_log.toArray()).filter(
        (row) => row.action === 'quote_expired_price_used',
      ),
    ).toHaveLength(1);
  });

  it('duplicates a quote into a fresh unsaved cart with a new number on save', async () => {
    const fx = await quoteFixture('quote-duplicate');
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: 'Original terms',
      staffId: 'st-1',
      now: NOW,
    });
    const copy = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c2',
      mode: 'duplicate',
      now: NOW + 1000,
    });
    expect(copy.quote).toMatchObject({
      quote_id: null,
      quote_no: null,
      mode: 'new',
      terms: 'Original terms',
    });
    expect(copy.lines).toHaveLength(2);
    const saved = await saveQuote(fx.db, {
      cartId: 'c2',
      cart: copy,
      money: fx.money,
      validUntil: VALID,
      terms: copy.quote?.terms ?? '',
      staffId: 'st-1',
      now: NOW + 2000,
    });
    expect(saved.quote.quote_no).toBe('QTN-A-2');
    expect(saved.quote.id).not.toBe(quote.id);
    expect(await fx.db.quotations.count()).toBe(2);
  });

  it('keeps a note and a deleted product snapshot when reloading a quote', async () => {
    const fx = await quoteFixture('quote-deleted');
    let cart = addQuickSale(t2Cart(fx.phone, fx.buds), {
      name: 'Repair labour',
      price: 50000,
      qtyMilli: 1000,
    });
    const quick = cart.lines.find((line) => line.product_id === null);
    if (!quick) throw new Error('missing quick line');
    cart = updateLine(cart, quick.key, { note: 'IMEI 123' });
    cart = {
      ...cart,
      quote: {
        quote_id: null,
        quote_no: null,
        valid_until: VALID,
        terms: '',
        mode: 'new',
      },
    };
    await fx.db.carts.put(cart);
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart,
      money: fx.money,
      validUntil: VALID,
      terms: '',
      staffId: 'st-1',
      now: NOW,
    });
    await fx.db.products.delete(fx.phone.id);
    const loaded = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c2',
      mode: 'edit',
      now: NOW + 1000,
    });
    expect(loaded.lines.find((line) => line.note === 'IMEI 123')).toBeTruthy();
    expect(loaded.lines.some((line) => line.product_id === fx.phone.id)).toBe(
      true,
    );
    const repriced = await startQuoteCart(fx.db, {
      quoteId: quote.id,
      cartId: 'c3',
      mode: 'convert',
      pricing: 'today',
      now: NOW + 10 * 86_400_000,
    });
    expect(
      repriced.lines.find((line) => line.note === 'IMEI 123'),
    ).toBeTruthy();
  });

  it('starts a new quote cart and shares a readable text', async () => {
    const fx = await quoteFixture('quote-new');
    const cart = await startNewQuote(fx.db, 'c3', NOW);
    expect(cart.quote).toMatchObject({
      mode: 'new',
      valid_until: '2026-11-03',
      terms: '',
    });
    const { quote } = await saveQuote(fx.db, {
      cartId: 'c1',
      cart: fx.cart,
      money: fx.money,
      validUntil: VALID,
      terms: 'Terms',
      staffId: 'st-1',
      now: NOW,
    });
    const lines = await fx.db.quotation_lines
      .where('quote_id')
      .equals(quote.id)
      .toArray();
    const text = quoteShareText(
      { ...quote, customer_name: 'Ali', note: 'Terms' },
      lines,
      'Bilal Mobile',
    );
    expect(text).toContain('QTN-A-1');
    expect(text).toContain('Bilal Mobile');
    expect(text).toContain('not a tax invoice');
    expect(text).toContain('Customer: Ali');
    expect(text).toContain('Terms: Terms');
    const jobId = await queueQuotePrint(fx.db, quote.id, { now: NOW });
    expect(await fx.db.print_jobs.get(jobId)).toMatchObject({
      quotation_id: quote.id,
      kind: 'quotation',
      status: 'queued',
    });
  });
});
