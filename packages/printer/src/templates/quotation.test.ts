import { describe, expect, it } from 'vitest';
import { renderReceiptText } from '../layout.ts';
import { buildQuotationReceipt } from './quotation.ts';

const shop = {
  name: 'Algovyn Mobiles',
  address: 'Hall Road, Lahore',
  phone: '+923001234567',
  receiptHeader: '',
  receiptFooter: 'Thank you',
  showPaymentDetails: true,
  showCashierOnReceipt: true,
  taxLabel: 'Sales tax',
  numberGrouping: 'intl' as const,
  ntn: '',
  strn: '',
  printWarranty: false,
  showYouSaved: false,
  timeZone: 'Asia/Karachi',
};

const quote = {
  quoteNo: 'QTN-A-1',
  createdAt: Date.parse('2026-10-27T09:00:00Z'),
  businessDate: '2026-10-27',
  validUntil: '2026-11-03',
  customerName: 'Ali Traders',
  staffName: 'Adnan',
  itemsQtyMilli: 2000,
  itemDiscountTotal: 200000,
  subtotal: 4550000,
  billDiscount: 50000,
  taxRateBp: 500,
  tax: 225000,
  taxInclusive: false,
  rounding: 0,
  total: 4725000,
  note: '50% advance',
};

const line = {
  name: 'Galaxy A15',
  qtyMilli: 1000,
  unitPrice: 4200000,
  discount: 200000,
  net: 4000000,
  warrantyUntil: null,
};

describe('quotation receipt (screens/21 AC 5)', () => {
  it('prints a QUOTATION with validity, customer, terms and no payment rows at 80 mm', () => {
    const text = renderReceiptText(
      buildQuotationReceipt({
        shop,
        quote,
        lines: [
          line,
          {
            name: 'Earbuds',
            qtyMilli: 1000,
            unitPrice: 500000,
            discount: 0,
            net: 500000,
            warrantyUntil: null,
          },
        ],
      }),
      { charsPerLine: 48, itemLayout: 'columns' },
    );
    expect(text).toContain('QUOTATION');
    expect(text).toContain('QTN-A-1');
    expect(text).toContain('Ali Traders');
    expect(text).toContain('Valid until');
    expect(text).toContain('50% advance');
    expect(text).toContain('47,250');
    expect(text).not.toMatch(/\bCash\b/u);
    expect(text).not.toContain('Change');
    expect(text).not.toContain('Udhaar');
    for (const row of text.split('\n'))
      expect(row.length).toBeLessThanOrEqual(48);
  });

  it('fits 32 columns at 58 mm and prints inclusive tax, discounts and rounding', () => {
    const text = renderReceiptText(
      buildQuotationReceipt({
        shop,
        quote: {
          ...quote,
          customerName: null,
          staffName: null,
          itemDiscountTotal: 0,
          billDiscount: 0,
          tax: 100000,
          taxInclusive: true,
          rounding: -500,
          note: '',
        },
        lines: [line],
      }),
      { charsPerLine: 32, itemLayout: 'stacked' },
    );
    expect(text).not.toContain('Ali Traders');
    expect(text).not.toContain('Adnan');
    expect(text).toContain('Includes');
    expect(text).toContain('Rounding');
    for (const row of text.split('\n'))
      expect(row.length).toBeLessThanOrEqual(32);
  });

  it('prints one bundle header with component quantities and no component prices', () => {
    const text = renderReceiptText(
      buildQuotationReceipt({
        shop,
        quote: { ...quote, itemsQtyMilli: 2000, note: '' },
        lines: [
          {
            ...line,
            name: 'Galaxy A15',
            bundleGroup: 'g1',
            bundleName: 'Starter Pack',
            bundleQty: 1,
            bundlePrice: 4550000,
          },
          {
            ...line,
            name: 'Earbuds',
            unitPrice: 350000,
            discount: 0,
            net: 350000,
            bundleGroup: 'g1',
            bundleName: 'Starter Pack',
            bundleQty: 1,
            bundlePrice: 4550000,
          },
        ],
      }),
      { charsPerLine: 48, itemLayout: 'columns' },
    );
    expect(text.match(/Starter Pack/gu)).toHaveLength(1);
    expect(text).toContain('Galaxy A15');
    expect(text).toContain('Earbuds');
    expect(text).not.toContain('40,000');
    expect(text).not.toContain('3,500');
  });
});
