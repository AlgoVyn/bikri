import { describe, expect, it } from 'vitest';
import { renderReceiptText } from '../layout.ts';
import { buildDayClose } from './dayClose.ts';
import type { DayCloseReceipt } from './types.ts';

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

const input = (counted: number): DayCloseReceipt => ({
  shop,
  staffName: 'Adnan',
  deviceName: 'Counter 1',
  periodStart: Date.UTC(2026, 9, 27, 4, 0),
  periodEnd: Date.UTC(2026, 9, 27, 14, 0),
  openingCash: 500000,
  cashSales: 4300000,
  udhaarCashIn: 50000,
  payIns: 0,
  supplierCashIn: 0,
  cashRefunds: 346000,
  cashExpenses: 30000,
  supplierCashOut: 550000,
  payOuts: 0,
  expectedCash: 3924000,
  countedCash: counted,
  difference: counted - 3924000,
  cardTotal: 120000,
  bankTotal: 300000,
  udhaarGiven: 250000,
  bills: 12,
  refunds: 1,
  note: counted === 3924000 ? '' : 'Short by 40',
});

describe('day close slip (screens/15 AC 7)', () => {
  it('prints the D1 lines at 80 mm without the customer receipt branding', () => {
    const blocks = buildDayClose(input(3924000));
    const text = renderReceiptText(blocks, {
      charsPerLine: 48,
      itemLayout: 'columns',
    });
    expect(text).toContain('DAY CLOSE');
    expect(text).toContain('Counter 1');
    expect(text).toContain('Opening cash');
    expect(text).toContain('Paid to suppliers (cash)');
    expect(text).toContain('Expected in drawer');
    expect(text).toContain('39,240');
    expect(text).toContain('Drawer is correct');
    expect(text).toContain('Closed by');
    expect(text).not.toContain('Powered by AlgoVyn');
    for (const line of text.split('\n'))
      expect(line.length).toBeLessThanOrEqual(48);
  });

  it('reports a short drawer and fits 32 columns at 58 mm', () => {
    const blocks = buildDayClose(input(3920000), {
      paperMm: 58,
      charsPerLine: 32,
    });
    const text = renderReceiptText(blocks, {
      charsPerLine: 32,
      itemLayout: 'stacked',
    });
    expect(text).toContain('Short');
    expect(text).toContain('Note: Short by 40');
    for (const line of text.split('\n'))
      expect(line.length).toBeLessThanOrEqual(32);
  });
});
