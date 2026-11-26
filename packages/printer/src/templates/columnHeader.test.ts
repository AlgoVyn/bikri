import { describe, expect, it } from 'vitest';
import {
  columnHeaderCells,
  formatColumnHeader,
  layOut,
  resolvePaper,
} from '../layout.ts';
import type { Block } from '../types.ts';
import { englishReceiptLabels } from './labels.ts';
import { buildQuotationReceipt } from './quotation.ts';
import { buildRefundReceipt } from './refund.ts';
import { buildSaleReceipt } from './sale.ts';
import { saleBasicInput } from './saleBasicFixture.ts';

const line = {
  name: 'Galaxy A15',
  qtyMilli: 1000,
  unitPrice: 100000,
  discount: 0,
  net: 100000,
  warrantyUntil: null,
};

function quotation(): Block[] {
  return buildQuotationReceipt(
    {
      shop: saleBasicInput().shop,
      quote: {
        quoteNo: 'QTN-1',
        createdAt: 0,
        businessDate: '2026-10-27',
        validUntil: '2026-11-03',
        customerName: null,
        staffName: null,
        itemsQtyMilli: 1000,
        itemDiscountTotal: 0,
        subtotal: 100000,
        billDiscount: 0,
        taxRateBp: 0,
        tax: 0,
        taxInclusive: false,
        rounding: 0,
        total: 100000,
        note: '',
      },
      lines: [line],
    },
    { paperMm: 80 },
  );
}

function refund(): Block[] {
  return buildRefundReceipt(
    {
      shop: saleBasicInput().shop,
      staffName: null,
      customerName: null,
      originalInvoiceNo: 'INV-1',
      originalCreatedAt: 0,
      refundCreatedAt: 0,
      lines: [{ name: 'Galaxy A15', qtyMilli: 1000, amount: 100000 }],
      exactAmount: 100000,
      rounding: 0,
      amount: 100000,
      method: 'cash',
      udhaarPart: 0,
      khataBalancePaisa: null,
      reason: 'Faulty',
    },
    { paperMm: 80 },
  );
}

describe('80 mm column headers (PRT-M2)', () => {
  it('exposes the header labels as start/qty-end/amount-end cells', () => {
    expect(columnHeaderCells(englishReceiptLabels)).toEqual([
      { text: 'ITEM' },
      { text: 'QTY', align: 'end' },
      { text: 'AMOUNT', align: 'end' },
    ]);
  });

  it('keeps the ASCII padded text and adds the cells in sale, quotation and refund', () => {
    const paper = resolvePaper({ paperMm: 80 });
    const headerText = formatColumnHeader(
      englishReceiptLabels,
      paper.charsPerLine,
    );
    for (const blocks of [
      buildSaleReceipt(saleBasicInput(), { paperMm: 80 }),
      quotation(),
      refund(),
    ]) {
      const header = blocks.find(
        (block) => block.t === 'text' && block.nowrap === true,
      );
      expect(header).toEqual({
        t: 'text',
        text: headerText,
        nowrap: true,
        cells: columnHeaderCells(englishReceiptLabels),
      });
    }
  });

  it('lays the header out as one text line with its cells intact', () => {
    const laid = layOut(
      [
        {
          t: 'text',
          text: formatColumnHeader(englishReceiptLabels, 48),
          nowrap: true,
          cells: columnHeaderCells(englishReceiptLabels),
        },
      ],
      { charsPerLine: 48, itemLayout: 'columns' },
    );
    expect(laid).toHaveLength(1);
    expect(laid[0]).toMatchObject({
      kind: 'text',
      cells: [
        { text: 'ITEM' },
        { text: 'QTY', align: 'end' },
        { text: 'AMOUNT', align: 'end' },
      ],
    });
  });
});
