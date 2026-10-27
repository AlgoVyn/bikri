import { describe, expect, it } from 'vitest';
import { renderReceiptText } from '../layout.ts';
import { buildSupplierReturn } from './supplierReturn.ts';

const shop = {
  name: 'Bikri',
  address: 'Hall Road',
  phone: '',
  receiptHeader: '',
  receiptFooter: '',
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

const input = {
  shop,
  supplierName: 'Ali Traders',
  purchaseInvoice: 'SUP-552',
  businessDate: '2026-10-27',
  lines: [{ name: 'Charger', qty: '2', unitCredit: 120000, lineTotal: 240000 }],
  total: 240000,
  refundReceived: 55000,
  refundMethod: 'cash' as const,
  reason: 'Faulty',
  note: '',
  balanceAfter: -190000,
};

describe('supplier return slip (screens/13 AC 6–8)', () => {
  it('prints the return, credit, money back and balance at 80 mm', () => {
    const text = renderReceiptText(buildSupplierReturn(input), {
      charsPerLine: 48,
      itemLayout: 'columns',
    });
    expect(text).toContain('RETURN TO SUPPLIER');
    expect(text).toContain('Ali Traders');
    expect(text).toContain('SUP-552');
    expect(text).toContain('Total credit');
    expect(text).toContain('2,400');
    expect(text).toContain('Money received');
    expect(text).toContain('550');
    expect(text).toContain('Reason: Faulty');
    expect(text).not.toContain('Powered by AlgoVyn');
    for (const line of text.split('\n'))
      expect(line.length).toBeLessThanOrEqual(48);
  });

  it('fits 32 columns at 58 mm', () => {
    const text = renderReceiptText(
      buildSupplierReturn(input, { paperMm: 58, charsPerLine: 32 }),
      { charsPerLine: 32, itemLayout: 'stacked' },
    );
    for (const line of text.split('\n'))
      expect(line.length).toBeLessThanOrEqual(32);
  });
});
