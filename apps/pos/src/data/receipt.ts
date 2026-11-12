/**
 * Receipt data for Sale complete (screens/07, T-018): the printer package's input built from
 * local rows, reprint jobs, and the WhatsApp share text/link (REQ-B04).
 */
import { businessDate, newId, parsePkPhone, saleLineFinal } from '@bikri/core';
import type { BikriDb, MasterRow, PrintJob, SyncedRow } from '@bikri/db';
import {
  formatIsoDate,
  formatReceiptDate,
  formatReceiptMoney,
  type ItemLayout,
  type ReceiptPayment,
  receiptLabelsFor,
  resolvePaper,
  type SaleReceiptInput,
} from '@bikri/printer';
import { readStoredLanguage } from '../i18n/i18n.ts';
import { customerBalance } from './customers.ts';
import { writeAction } from './write.ts';

/** `kv.printer` (06 §8, screens/17 Printer). Missing fields take the defaults noted. */
export type PrinterKv = {
  transport?: 'usb' | 'serial' | 'system' | 'agent';
  /** Physical paper/head width. Default 80. */
  paper_mm?: 58 | 80;
  /** Printer's current printable line width. 32 = a 58 mm printer setting. */
  chars_per_line?: number;
  /** Print area width in dots. 384 = 58 mm print, 512/576 = 80 mm print. */
  dots?: number;
  usb?: {
    vendorId: number;
    productId: number;
    serialNumber?: string | null;
    name?: string;
  };
  serial?: {
    usbVendorId?: number;
    usbProductId?: number;
    baudRate: number;
    flowControl: 'none' | 'hardware';
  };
  /** Local print agent (docs/14-print-agent.md). The token is device-local and never exported. */
  agent?: {
    url: string;
    token: string;
    agentId: string;
    printerName: string;
    mode: 'raw' | 'driver';
  };
  /** Default partial. */
  cut?: 'partial' | 'full' | 'none';
  /** QR with the bill id. Default off. */
  qr?: boolean;
  /** Default 2. */
  drawer_pin?: 2 | 5;
  status_query?: boolean;
  /** Print after every sale. Default on. */
  auto_print?: boolean;
  /** 1–3, default 1. */
  copies?: number;
  /** Default on. */
  print_logo?: boolean;
  /** Open the drawer for sales with cash. Default on. */
  drawer?: boolean;
};

export type ReceiptPaper = {
  /** Physical paper/head width. */
  paperMm: 58 | 80;
  /** Width the printer is currently configured to print (58 or 80 mm). */
  printMm: 58 | 80;
  /** Physical print width in mm at 203 dpi (24 chars → 36 mm, 32 → 48, 48 → 72). */
  printWidthMm: number;
  charsPerLine: number;
  dots: number;
  /** Full paper/head width in dots. */
  paperDots: number;
  /** Left margin that centres the print area on the paper. */
  leftMarginDots: number;
  /** True only when Bikri must override the printer's native width/margin. */
  sendWidth: boolean;
  itemLayout: ItemLayout;
  qr: boolean;
};

/** Paper of the configured printer; 80 mm (48 chars, 576 dots) when none is set up. */
export function receiptPaper(
  printer: PrinterKv | null | undefined,
): ReceiptPaper {
  const paperMm = printer?.paper_mm === 58 ? 58 : 80;
  const charsPerLine = printer?.chars_per_line ?? (paperMm === 58 ? 32 : 48);
  const dots = printer?.dots ?? dotsForChars(charsPerLine);
  const resolved = resolvePaper({ paperMm, charsPerLine, dots });
  return {
    paperMm,
    printMm: dots <= 384 ? 58 : 80,
    printWidthMm: Math.round(dots / 8),
    charsPerLine,
    dots,
    paperDots: resolved.paperDots,
    leftMarginDots: resolved.leftMarginDots,
    sendWidth: paperMm !== (dots <= 384 ? 58 : 80),
    itemLayout: resolved.itemLayout,
    qr: printer?.qr === true,
  };
}

/** Default print-area dots for the wizard's character choices. */
function dotsForChars(chars: number): number {
  if (chars <= 24) return 288;
  if (chars <= 32) return 384;
  if (chars === 42) return 512;
  return 576;
}

const PAY_METHODS = new Set(['cash', 'card', 'bank_wallet']);

/** Everything the sale receipt prints, read from this shop's local database. */
export async function loadSaleReceipt(
  db: BikriDb,
  saleId: string,
  options: { reprint?: boolean } = {},
): Promise<SaleReceiptInput | null> {
  const sale = await db.sales.get(saleId);
  if (!sale) return null;
  const { shop, receiptLanguage } = await receiptShop(db);
  const lines = await db.sale_lines
    .where('sale_id')
    .equals(saleId)
    .sortBy('line_no');
  const payments = (await db.payments.where('sale_id').equals(saleId).toArray())
    .filter((p) => p.direction === 'in' && PAY_METHODS.has(String(p.method)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const staff = sale.staff_id
    ? await db.staff.get(String(sale.staff_id))
    : undefined;
  const customerId = sale.customer_id ? String(sale.customer_id) : null;
  const customer = customerId ? await db.customers.get(customerId) : undefined;
  const udhaar = Number(sale.udhaar_amount ?? 0);
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    shop,
    sale: {
      id: saleId,
      invoiceNo: String(sale.invoice_no),
      createdAt: Number(sale.created_at),
      businessDate: String(sale.business_date),
      late:
        businessDate(Number(sale.created_at), shop.timeZone) !==
        String(sale.business_date),
      itemsQtyMilli: Number(sale.items_qty_milli ?? 0),
      itemDiscountTotal: Number(sale.item_discount_total ?? 0),
      subtotal: Number(sale.subtotal ?? 0),
      billDiscount: Number(sale.bill_discount ?? 0),
      taxRateBp: Number(sale.tax_rate_bp ?? 0),
      tax: Number(sale.tax ?? 0),
      taxInclusive: sale.tax_inclusive === 1,
      rounding: Number(sale.rounding ?? 0),
      total: Number(sale.total ?? 0),
      udhaarAmount: udhaar,
      cashTendered: Number(sale.cash_tendered ?? 0),
      changeGiven: Number(sale.change_given ?? 0),
      customerName: customer ? String(customer.name) : null,
      khataBalancePaisa:
        udhaar > 0 && customerId ? await customerBalance(db, customerId) : null,
      reprint: options.reprint === true,
    },
    lines: lines.map((l: SyncedRow) => ({
      name: String(l.name_snapshot),
      qtyMilli: Number(l.qty_milli),
      unitPrice: Number(l.unit_price),
      discount: Number(l.discount ?? 0),
      net: Number(l.net),
      final: saleLineFinal(
        {
          net: Number(l.net),
          bill_discount_alloc: Number(l.bill_discount_alloc ?? 0),
          tax_alloc: Number(l.tax_alloc ?? 0),
          rounding_alloc: Number(l.rounding_alloc ?? 0),
        },
        sale.tax_inclusive === 1,
      ),
      warrantyUntil: l.warranty_until ? String(l.warranty_until) : null,
    })),
    payments: payments.map(
      (p): ReceiptPayment => ({
        method: p.method as ReceiptPayment['method'],
        amount: Number(p.amount),
        reference:
          [text(p.note), text(p.reference)].filter(Boolean).join(' ') ||
          undefined,
      }),
    ),
    staffName: staff ? String(staff.name) : null,
    // Urdu receipts get Urdu labels (the whole receipt is rasterised, 06 §6).
    labels: receiptLabelsFor(receiptLanguage),
  };
}

/**
 * ``app`` follows the device language (Urdu only; Roman Urdu receipts use English labels).
 * One helper keeps receipts, refunds and the preview in step with labels (D-101).
 */
export function resolveReceiptLanguage(
  value: string | null | undefined,
  uiLanguage: string = readStoredLanguage(),
): 'ur' | 'en' {
  return value === 'ur' || (value === 'app' && uiLanguage === 'ur')
    ? 'ur'
    : 'en';
}

/** Shop fields every receipt prints, plus the receipt language (D-101). */
export async function receiptShop(
  db: BikriDb,
): Promise<{ shop: SaleReceiptInput['shop']; receiptLanguage: string }> {
  const row = (await db.shop.get('shop')) as MasterRow | undefined;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const receiptLanguage = resolveReceiptLanguage(text(row?.receipt_language));
  return {
    receiptLanguage,
    shop: {
      name: text(row?.name),
      address: text(row?.address),
      phone: text(row?.phone),
      receiptHeader: text(row?.receipt_header),
      receiptFooter: text(row?.receipt_footer),
      showPaymentDetails: Number(row?.show_payment_details ?? 1) !== 0,
      showCashierOnReceipt: Number(row?.show_cashier_on_receipt ?? 1) !== 0,
      taxLabel:
        text(row?.tax_label) ||
        (receiptLanguage === 'ur' ? 'سیلز ٹیکس' : 'Sales tax'),
      numberGrouping: row?.number_grouping === 'lakh' ? 'lakh' : 'intl',
      ntn: text(row?.ntn),
      strn: text(row?.strn),
      printWarranty: Number(row?.print_warranty ?? 1) !== 0,
      showYouSaved: Number(row?.show_you_saved ?? 0) === 1,
      timeZone: text(row?.timezone) || 'Asia/Karachi',
    },
  };
}

/** Queues a print job for a sale; `reprint` prints "REPRINT" under the title (screens/07 AC 3). */
export async function queueSalePrint(
  db: BikriDb,
  saleId: string,
  options: { reprint?: boolean; now?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const id = newId(now);
  await db.print_jobs.put({
    id,
    sale_id: saleId,
    kind: 'sale',
    status: 'queued',
    reprint: options.reprint === true,
    created_at: now,
  });
  return id;
}

/** Latest print job of a sale, for the status line. */
export async function latestSaleJob(
  db: BikriDb,
  saleId: string,
): Promise<PrintJob | undefined> {
  const jobs = await db.print_jobs.where('sale_id').equals(saleId).toArray();
  return jobs.sort(
    (a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id),
  )[0];
}

/** Pakistani number as wa.me wants it: digits only, country code 92, no leading 0 or +. */
export function waNumber(phone: string): string | null {
  let digits = phone.replace(/\D/gu, '');
  if (digits.startsWith('0092')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('3'))
    digits = `92${digits}`;
  if (!/^92\d{9,10}$/u.test(digits)) return null;
  // WhatsApp only works for mobile numbers; parsePkPhone rejects landlines.
  return parsePkPhone(`+${digits}`)?.mobile === true ? digits : null;
}

/** Short plain-text bill for the WhatsApp message (the PNG carries the full layout). */
export function receiptShareText(input: SaleReceiptInput): string {
  const { shop, sale } = input;
  const money = (p: number) => formatReceiptMoney(p, shop.numberGrouping);
  const labels = input.labels ?? receiptLabelsFor('en');
  const rows = [
    shop.name,
    `${labels.bill} ${sale.invoiceNo} · ${
      sale.late
        ? formatIsoDate(sale.businessDate)
        : formatReceiptDate(sale.createdAt, shop.timeZone)
    }`,
    ...input.lines.map((l) => {
      const qty =
        l.qtyMilli % 1000 === 0
          ? String(l.qtyMilli / 1000)
          : (l.qtyMilli / 1000).toFixed(3);
      return `${l.name} × ${qty}  ${money(l.final ?? l.net)}`;
    }),
    `${labels.total} ${money(sale.total)}`,
  ];
  if (sale.udhaarAmount > 0) {
    rows.push(`${labels.udhaar} ${money(sale.udhaarAmount)}`);
    if (sale.khataBalancePaisa !== null)
      rows.push(`${labels.khataBalance} ${money(sale.khataBalancePaisa)}`);
  }
  if (shop.receiptFooter.trim()) rows.push(shop.receiptFooter.trim());
  return rows.join('\n');
}

/** `https://wa.me/92300…?text=…` (REQ-B04), or null when the phone is not a valid number. */
export function waLink(phone: string, text: string): string | null {
  const number = waNumber(phone);
  return number
    ? `https://wa.me/${number}?text=${encodeURIComponent(text)}`
    : null;
}

/** F9 "Open drawer" is audited (06 §7, permission `drawer.open`). */
export async function logDrawerOpen(
  db: BikriDb,
  ctx: { device_id: string; staff_id: string | null },
  now = Date.now(),
): Promise<void> {
  await writeAction(
    db,
    (w) =>
      w.insert('audit_log', {
        id: newId(now),
        action: 'drawer_open',
        entity: 'device',
        entity_id: ctx.device_id,
        before_json: null,
        after_json: null,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        created_at: now,
      }),
    { now, actor: ctx.staff_id },
  );
}
