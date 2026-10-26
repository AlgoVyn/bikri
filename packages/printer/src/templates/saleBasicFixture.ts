import type { SaleReceiptInput } from './sale.ts';

/**
 * T2 cart from 07 §3.3 / 10 §4.
 * Phone Rs 42,000 less Rs 2,000 + earbuds Rs 3,500, bill discount Rs 500,
 * cash tendered Rs 50,000, change Rs 7,000. Shop "Algovyn Mobiles".
 * Address, invoice and timestamp follow the 06 §4 sample so columns can be checked by eye.
 */
export function saleBasicInput(): SaleReceiptInput {
  return {
    shop: {
      name: 'Algovyn Mobiles',
      address: 'Shop 12, Hall Road, Lahore',
      phone: '03001234567',
      receiptHeader: '',
      receiptFooter: 'Shukriya! Phir tashreef laiye.',
      showPaymentDetails: true,
      showCashierOnReceipt: true,
      taxLabel: 'Sales tax',
      numberGrouping: 'intl',
      ntn: '',
      strn: '',
      printWarranty: true,
      showYouSaved: false,
      timeZone: 'Asia/Karachi',
    },
    sale: {
      id: '01SALEBASIC000000000000000',
      invoiceNo: 'INV-A-1042',
      createdAt: Date.parse('2026-10-27T09:05:00.000Z'),
      businessDate: '2026-10-27',
      itemsQtyMilli: 2000,
      itemDiscountTotal: 200_000,
      subtotal: 4_350_000,
      billDiscount: 50_000,
      taxRateBp: 0,
      tax: 0,
      taxInclusive: false,
      rounding: 0,
      total: 4_300_000,
      udhaarAmount: 0,
      cashTendered: 5_000_000,
      changeGiven: 700_000,
      customerName: null,
      khataBalancePaisa: null,
    },
    lines: [
      {
        name: 'Samsung A15 4/128 Blue',
        qtyMilli: 1000,
        unitPrice: 4_200_000,
        discount: 200_000,
        net: 4_000_000,
        warrantyUntil: null,
      },
      {
        name: 'Earbuds',
        qtyMilli: 1000,
        unitPrice: 350_000,
        discount: 0,
        net: 350_000,
        warrantyUntil: null,
      },
    ],
    payments: [{ method: 'cash', amount: 4_300_000 }],
    staffName: 'Adnan',
  };
}
