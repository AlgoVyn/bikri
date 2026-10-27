import type { NumberGrouping } from '@bikri/core';

/** Shop fields the receipt actually prints. Names match `shop` in 02. */
export type ReceiptShop = {
  name: string;
  address: string;
  phone: string;
  receiptHeader: string;
  receiptFooter: string;
  showPaymentDetails: boolean;
  showCashierOnReceipt: boolean;
  taxLabel: string;
  numberGrouping: NumberGrouping;
  ntn: string;
  strn: string;
  printWarranty: boolean;
  showYouSaved: boolean;
  timeZone: string;
};

export type ReceiptLine = {
  name: string;
  qtyMilli: number;
  unitPrice: number;
  /** Line discount in paisa (already applied). */
  discount: number;
  /** Line net (gross − line discount). This is the amount column. */
  net: number;
  /** `YYYY-MM-DD`, snapshotted on the sale line. */
  warrantyUntil: string | null;
};

export type ReceiptPayment = {
  method: 'cash' | 'card' | 'bank_wallet';
  /** Applied amount, not tendered. */
  amount: number;
  reference?: string;
};

export type ReceiptSale = {
  /** Bill id. Printed as the QR payload when QR is on. */
  id: string;
  invoiceNo: string;
  /** Epoch ms. Printed as `DD-MM-YYYY HH:mm` in `shop.timeZone`. */
  createdAt: number;
  /** `YYYY-MM-DD`. Warranty day counts start here. */
  businessDate: string;
  itemsQtyMilli: number;
  itemDiscountTotal: number;
  /** Sum of line nets (`sales.subtotal`). */
  subtotal: number;
  billDiscount: number;
  taxRateBp: number;
  tax: number;
  taxInclusive: boolean;
  rounding: number;
  total: number;
  udhaarAmount: number;
  cashTendered: number;
  changeGiven: number;
  customerName: string | null;
  /** Printed as "Khata balance now" when the bill has an udhaar part. */
  khataBalancePaisa: number | null;
  reprint?: boolean;
};

/** Visible strings. `{n}`, `{label}`, `{rate}`, `{name}`, `{days}`, `{date}` are filled in. */
export type ReceiptLabels = {
  saleTitle: string;
  refundTitle: string;
  testTitle: string;
  bill: string;
  date: string;
  cashier: string;
  customer: string;
  item: string;
  qty: string;
  amount: string;
  discount: string;
  total: string;
  rounding: string;
  cash: string;
  card: string;
  bankWallet: string;
  amountTendered: string;
  tenderedShort: string;
  change: string;
  udhaar: string;
  khataBalance: string;
  takenOffKhata: string;
  youSaved: string;
  reason: string;
  exact: string;
  paidBack: string;
  originalBill: string;
  originalDate: string;
  reprint: string;
  telPrefix: string;
  ntn: string;
  strn: string;
  each: string;
  less: string;
  drawerWorks: string;
  boldSample: string;
  doubleSample: string;
  urduSample: string;
  warrantyOne: string;
  warrantyMany: string;
  subtotalItems: string;
  subtotalItem: string;
  subtotalCount: string;
  includesTax: string;
  salesTax: string;
};

export type RefundLine = {
  name: string;
  qtyMilli: number;
  /** Exact line refund in paisa. */
  amount: number;
};

export type RefundReceipt = {
  shop: ReceiptShop;
  staffName: string | null;
  customerName: string | null;
  originalInvoiceNo: string;
  originalCreatedAt: number;
  refundCreatedAt: number;
  lines: RefundLine[];
  exactAmount: number;
  rounding: number;
  /** Money handed back. 0 when the whole refund stays on the khata. */
  amount: number;
  method: 'cash' | 'card' | 'bank_wallet' | null;
  udhaarPart: number;
  khataBalancePaisa: number | null;
  reason: string;
};

/** Day close / Z-report (screens/15); an internal slip, so no "Powered by AlgoVyn". */
export type DayCloseReceipt = {
  shop: ReceiptShop;
  staffName: string | null;
  deviceName: string;
  periodStart: number;
  periodEnd: number;
  openingCash: number;
  cashSales: number;
  udhaarCashIn: number;
  payIns: number;
  supplierCashIn: number;
  cashRefunds: number;
  cashExpenses: number;
  supplierCashOut: number;
  payOuts: number;
  expectedCash: number;
  countedCash: number;
  difference: number;
  cardTotal: number;
  bankTotal: number;
  udhaarGiven: number;
  bills: number;
  refunds: number;
  note: string;
  labels?: Partial<DayCloseLabels>;
};

export type DayCloseLabels = {
  title: string;
  device: string;
  from: string;
  to: string;
  opening: string;
  cashSales: string;
  udhaarIn: string;
  payIns: string;
  supplierIn: string;
  cashRefunds: string;
  cashExpenses: string;
  supplierOut: string;
  payOuts: string;
  expected: string;
  counted: string;
  difference: string;
  correct: string;
  short: string;
  over: string;
  card: string;
  bank: string;
  udhaarGiven: string;
  bills: string;
  refunds: string;
  note: string;
  closedBy: string;
};

/** Return-to-supplier slip (screens/13, 06 §4.3); an internal slip. */
export type SupplierReturnReceipt = {
  shop: ReceiptShop;
  supplierName: string;
  purchaseInvoice: string | null;
  businessDate: string;
  lines: { name: string; qty: string; unitCredit: number; lineTotal: number }[];
  total: number;
  refundReceived: number;
  refundMethod: 'cash' | 'bank_wallet' | null;
  reason: string;
  note: string;
  balanceAfter: number;
  labels?: Partial<SupplierReturnLabels>;
};

export type SupplierReturnLabels = {
  title: string;
  supplier: string;
  delivery: string;
  date: string;
  total: string;
  received: string;
  reason: string;
  note: string;
  balance: string;
  methodCash: string;
  methodBank: string;
};
