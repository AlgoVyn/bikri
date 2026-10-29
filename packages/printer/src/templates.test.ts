import { describe, expect, it } from 'vitest';
import {
  calendarDaysBetween,
  formatIsoDate,
  formatItemCount,
  formatReceiptDate,
  formatReceiptMoney,
  formatReceiptPhone,
  formatTaxRate,
} from './format.ts';
import { fromHexLines, toHexLines } from './golden.ts';
import {
  buildRefundReceipt,
  buildSaleReceipt,
  buildTestPrint,
  POWERED_BY,
  type RefundReceipt,
  renderReceiptText,
  resolvePaper,
  type SaleReceiptInput,
  saleBasicInput,
} from './index.ts';

function text80(blocks: ReturnType<typeof buildSaleReceipt>): string {
  return renderReceiptText(blocks, resolvePaper({ paperMm: 80 }));
}

function variant(change: (input: SaleReceiptInput) => void): SaleReceiptInput {
  const input = saleBasicInput();
  change(input);
  return input;
}

describe('sale receipt conditional rows (06 §4.1)', () => {
  it('adds the tax row for tax-exclusive sales', () => {
    const t = text80(
      buildSaleReceipt(
        variant((i) => {
          i.sale.taxRateBp = 1700;
          i.sale.tax = 731_000;
        }),
      ),
    );
    expect(t).toMatch(/^Sales tax 17% +Rs 7,310$/m);
  });

  it('prints "Includes … tax" after TOTAL for tax-inclusive sales and no tax row (T9)', () => {
    const t = text80(
      buildSaleReceipt(
        variant((i) => {
          i.sale.taxRateBp = 1700;
          i.sale.tax = 170_000;
          i.sale.taxInclusive = true;
        }),
      ),
    );
    expect(t).toMatch(/^Includes Sales tax 17%: +Rs 1,700$/m);
    expect(t).not.toMatch(/^Sales tax/m);
    expect(t.indexOf('Includes')).toBeGreaterThan(t.indexOf('TOTAL'));
  });

  it('shows rounding, udhaar with khata balance, customer, card and bank/wallet references', () => {
    const t = text80(
      buildSaleReceipt(
        variant((i) => {
          i.sale.rounding = -50;
          i.sale.udhaarAmount = 1_000_000;
          i.sale.khataBalancePaisa = 2_500_000;
          i.sale.customerName = 'Bilal Hussain';
          i.payments = [
            { method: 'card', amount: 2_000_000, reference: '4421' },
            { method: 'bank_wallet', amount: 1_299_950, reference: 'JazzCash' },
          ];
        }),
      ),
    );
    expect(t).toMatch(/^Rounding +-Rs 0\.50$/m);
    expect(t).toMatch(/^Udhaar \(on khata\) +Rs 10,000$/m);
    expect(t).toMatch(/^Khata balance now +Rs 25,000$/m);
    expect(t).toMatch(/^Customer +Bilal Hussain$/m);
    expect(t).toMatch(/^Card 4421 +Rs 20,000$/m);
    expect(t).toMatch(/^Bank\/wallet JazzCash +Rs 12,999\.50$/m);
    expect(t).not.toContain('Amount tendered');
  });

  it('hides payment rows and the cashier when the shop turns them off', () => {
    const t = text80(
      buildSaleReceipt(
        variant((i) => {
          i.shop.showPaymentDetails = false;
          i.shop.showCashierOnReceipt = false;
          i.sale.udhaarAmount = 50_000;
          i.sale.khataBalancePaisa = 250_000;
        }),
      ),
    );
    expect(t).not.toMatch(/^Cash /m);
    expect(t).not.toContain('Cashier');
    // Udhaar is part of the bill's trust, not a payment-detail row.
    expect(t).toMatch(/^Udhaar \(on khata\) +Rs 500$/m);
    expect(t).toMatch(/^Khata balance now +Rs 2,500$/m);
  });

  it('prints warranty lines, you saved, NTN/STRN, header, REPRINT and the QR when enabled', () => {
    const input = variant((i) => {
      i.shop.showYouSaved = true;
      i.shop.ntn = '1234567-8';
      i.shop.strn = '32-77-8761-123-45';
      i.shop.receiptHeader = 'Open daily 11am to 10pm';
      i.sale.reprint = true;
      const [phone, buds] = i.lines;
      if (phone !== undefined) phone.warrantyUntil = '2027-10-27';
      if (buds !== undefined) buds.warrantyUntil = '2026-10-28';
    });
    const blocks = buildSaleReceipt(input, { qr: true, printLogo: false });
    const t = text80(blocks);
    // Long warranty lines wrap at the paper width (the 06 §4.1 sample line is wider than 48).
    const joined = t.replace(/ *\n/g, ' ');
    expect(joined).toContain(
      'Warranty: Samsung A15 4/128 Blue - 365 days (till 27-10-2027)',
    );
    expect(joined).toContain('Warranty: Earbuds - 1 day (till 28-10-2026)');
    expect(t).toMatch(/^You saved +Rs 2,500$/m);
    expect(t).toContain('NTN: 1234567-8');
    expect(t).toContain('STRN: 32-77-8761-123-45');
    expect(t).toContain('Open daily 11am to 10pm');
    expect(t).toContain('REPRINT');
    expect(blocks).toContainEqual({ t: 'qr', data: input.sale.id });
    expect(blocks.some((b) => b.t === 'logo')).toBe(false);
  });

  it('skips warranty lines when the shop turns warranty printing off', () => {
    const input = variant((i) => {
      i.shop.printWarranty = false;
      const [phone] = i.lines;
      if (phone !== undefined) phone.warrantyUntil = '2027-10-27';
    });
    expect(text80(buildSaleReceipt(input))).not.toContain('Warranty');
  });

  it('uses lakh grouping and a smaller shop name size when the name is long', () => {
    const blocks = buildSaleReceipt(
      variant((i) => {
        i.shop.numberGrouping = 'lakh';
        i.shop.name = 'Algovyn Mobiles and Accessories Hall Road';
      }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({ t: 'text', size: 'double-height', bold: true }),
    );
    expect(text80(blocks)).toMatch(/^Subtotal \(2 items\) +Rs 43,500$/m);
  });

  it('takes branding only from the shop passed in (multi-tenant, 06 §4)', () => {
    const a = text80(buildSaleReceipt(saleBasicInput()));
    const b = text80(
      buildSaleReceipt(
        variant((i) => {
          i.shop.name = 'Hall Road Mobiles';
          i.shop.address = 'Shop 3, Hall Road, Lahore';
        }),
      ),
    );
    expect(a).toContain('Algovyn Mobiles');
    expect(b).toContain('Hall Road Mobiles');
    expect(b).not.toContain('Algovyn Mobiles');
    expect(a).not.toContain('Bikri');
  });

  it('uses the singular item label for one item and accepts label overrides', () => {
    const t = text80(
      buildSaleReceipt(
        variant((i) => {
          i.lines = i.lines.slice(0, 1);
          i.sale.itemsQtyMilli = 1000;
          i.labels = { saleTitle: 'BILL' };
        }),
      ),
    );
    expect(t).toContain('Subtotal (1 item)');
    expect(t).toContain('BILL');
  });
});

describe('Powered by AlgoVyn footer (D-085)', () => {
  it('is the last text line of sale and refund receipts at 58 and 80 mm, after the QR', () => {
    for (const mm of [58, 80] as const) {
      const sale = buildSaleReceipt(saleBasicInput(), {
        paperMm: mm,
        qr: true,
      });
      const refund = buildRefundReceipt(
        {
          shop: saleBasicInput().shop,
          staffName: null,
          customerName: null,
          originalInvoiceNo: 'INV-A-1',
          originalCreatedAt: 0,
          refundCreatedAt: 0,
          lines: [],
          exactAmount: 0,
          rounding: 0,
          amount: 0,
          method: null,
          udhaarPart: 0,
          khataBalancePaisa: null,
          reason: 'x',
          labels: { saleTitle: 'X' },
        },
        { paperMm: mm },
      );
      for (const blocks of [sale, refund]) {
        const texts = blocks.filter((b) => b.t === 'text' || b.t === 'qr');
        expect(texts.at(-1)).toEqual({
          t: 'text',
          text: POWERED_BY,
          align: 'center',
          size: 'small',
        });
        const t = renderReceiptText(blocks, resolvePaper({ paperMm: mm }));
        expect(t.trimEnd().split('\n').at(-1)?.trim()).toBe(
          'Powered by AlgoVyn',
        );
      }
    }
  });
});

describe('refund receipt (06 §4.3)', () => {
  const base = (): RefundReceipt => ({
    shop: saleBasicInput().shop,
    staffName: 'Adnan',
    customerName: null,
    originalInvoiceNo: 'INV-A-1042',
    originalCreatedAt: Date.parse('2026-10-27T09:05:00.000Z'),
    refundCreatedAt: Date.parse('2026-10-28T10:00:00.000Z'),
    lines: [{ name: 'Earbuds', qtyMilli: 1000, amount: 349_950 }],
    exactAmount: 349_950,
    rounding: 50,
    amount: 350_000,
    method: 'cash',
    udhaarPart: 0,
    khataBalancePaisa: null,
    reason: 'Faulty',
  });

  it('prints original bill, exact, rounding, money back and reason; kicks the drawer for cash', () => {
    const blocks = buildRefundReceipt(base());
    const t = text80(blocks);
    expect(t).toContain('REFUND RECEIPT');
    expect(t).toMatch(/^Original bill +INV-A-1042$/m);
    expect(t).toMatch(/^Exact +Rs 3,499\.50$/m);
    expect(t).toMatch(/^Rounding +Rs 0\.50$/m);
    expect(t).toMatch(/^Cash +Rs 3,500$/m);
    expect(t).toContain('Faulty');
    expect(blocks.at(-1)).toEqual({ t: 'drawer' });
  });

  it('names card and bank/wallet refunds and does not open the drawer for them', () => {
    for (const method of ['card', 'bank_wallet'] as const) {
      const blocks = buildRefundReceipt({ ...base(), method }, { paperMm: 58 });
      expect(blocks.some((b) => b.t === 'drawer')).toBe(false);
      const t = renderReceiptText(blocks, resolvePaper({ paperMm: 58 }));
      expect(t).toMatch(method === 'card' ? /^Card /m : /^Bank\/wallet /m);
    }
  });
});

describe('test print (06 §4.3, §8)', () => {
  it('has the ruler at exactly chars_per_line, Urdu line, QR, cut and drawer', () => {
    const blocks = buildTestPrint({ charsPerLine: 42 });
    expect(blocks).toContainEqual({
      t: 'text',
      text: '123456789012345678901234567890123456789012',
    });
    expect(blocks).toContainEqual(
      expect.objectContaining({ text: 'اردو ٹیسٹ پرنٹ' }),
    );
    expect(blocks.some((b) => b.t === 'qr')).toBe(true);
    expect(blocks.slice(-2)).toEqual([{ t: 'cut' }, { t: 'drawer' }]);
    expect(
      buildTestPrint({
        charsPerLine: 32,
        drawer: false,
        printLogo: false,
      }).some((b) => b.t === 'drawer' || b.t === 'logo'),
    ).toBe(false);
  });
});

describe('format helpers', () => {
  it('formats money with ASCII minus and both groupings', () => {
    expect(formatReceiptMoney(4_000_000)).toBe('Rs 40,000');
    expect(formatReceiptMoney(345_977)).toBe('Rs 3,459.77');
    expect(formatReceiptMoney(-50_000)).toBe('-Rs 500');
    expect(formatReceiptMoney(1_234_567_800, 'lakh')).toBe('Rs 1,23,45,678');
  });

  it('formats quantities, tax rates, dates and phones', () => {
    expect(formatItemCount(1250)).toBe('1.25');
    expect(formatItemCount(-500)).toBe('-0.5');
    expect(() => formatItemCount(1.5)).toThrow();
    expect(formatTaxRate(1750)).toBe('17.5');
    expect(formatTaxRate(-100)).toBe('-1');
    expect(() => formatTaxRate(0.5)).toThrow();
    expect(formatReceiptDate(Date.parse('2026-10-27T19:30:00Z'))).toBe(
      '28-10-2026 00:30',
    );
    expect(formatIsoDate('2026-10-27')).toBe('27-10-2026');
    expect(formatIsoDate('soon')).toBe('soon');
    expect(calendarDaysBetween('2026-10-27', 'x')).toBe(0);
    expect(formatReceiptPhone('+923001234567')).toBe('0300 1234567');
    expect(formatReceiptPhone('  ')).toBe('');
    expect(formatReceiptPhone('ext 12')).toBe('ext 12');
  });
});

describe('golden helpers', () => {
  it('round-trips bytes through hex lines and rejects junk', () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => i * 13);
    const hex = toHexLines(bytes);
    expect(hex.split('\n')).toHaveLength(3);
    expect([...fromHexLines(hex)]).toEqual([...bytes]);
    expect(() => fromHexLines('zz')).toThrow();
  });
});
