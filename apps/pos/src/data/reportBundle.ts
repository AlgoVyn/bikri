import {
  businessDate,
  isTimeZone,
  mulDivRound,
  refundedCost,
  refundedRevenue,
  refundedTax,
} from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import {
  clampReportRange,
  firstBusinessDay,
  monthChunks,
} from './reportRange.ts';
import { lineRevenue, type ReportRange } from './reports.ts';

const DAY = 86_400_000;
const n = (v: unknown): number => Number(v ?? 0);
const CHUNK = 2_000;

export type PaymentMix = {
  cash: number;
  card: number;
  bank_wallet: number;
  udhaar: number;
};

export type HourlyPoint = {
  hour: number;
  sold: number;
  bills: number;
};

export type DailyPoint = {
  date: string;
  sold: number;
  bills: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  tax: number;
  udhaarGiven: number;
  udhaarReceived: number;
  mix: PaymentMix;
};

export type ReportSummary = {
  sold: number;
  bills: number;
  avgBill: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  marginBp: number;
  udhaarGiven: number;
  udhaarReceived: number;
  tax: number;
  refunded: number;
  refundCount: number;
  paymentMix: PaymentMix;
  daily: DailyPoint[];
  hourly: HourlyPoint[];
};

export type ProductReportRow = {
  key: string;
  productId: string | null;
  name: string;
  nameUr: string;
  sku: string;
  unit: string;
  categoryId: string | null;
  brand: string;
  qtyMilli: number;
  revenue: number;
  cost: number;
  profit: number;
};

export type GroupReportRow = {
  key: string;
  name: string;
  nameUr: string;
  qtyMilli: number;
  revenue: number;
  cost: number;
  profit: number;
};

export type SlowMover = {
  product: MasterRow;
  onHand: number;
  lastSale: string | null;
};

export type ProductReports = {
  rows: ProductReportRow[];
  bestByQty: ProductReportRow[];
  bestByRevenue: ProductReportRow[];
  bestByProfit: ProductReportRow[];
  categories: GroupReportRow[];
  brands: GroupReportRow[];
  slowMovers: SlowMover[];
};

export type StockItem = {
  product: MasterRow;
  onHand: number;
  value: number;
  status: 'ok' | 'low' | 'out' | 'negative';
};

export type MovementSummaryRow = {
  reason: string;
  count: number;
  inQty: number;
  outQty: number;
  netQty: number;
};

export type SupplierReturnRow = {
  id: string;
  date: string;
  supplierId: string;
  supplierName: string;
  lineCount: number;
  total: number;
  difference: number;
};

export type StockReport = {
  value: number;
  items: StockItem[];
  lowStock: StockItem[];
  outOfStock: StockItem[];
  negativeStock: StockItem[];
  attention: StockItem[];
  movements: MovementSummaryRow[];
  supplierReturns: {
    count: number;
    credit: number;
    difference: number;
    rows: SupplierReturnRow[];
  };
};

export type AgeBucket = 'promise' | '0-7' | '8-30' | '31-60' | '60+';

export type UdhaarRow = {
  customer: MasterRow;
  balance: number;
  ageDays: number;
  promiseDate: string | null;
  bucket: AgeBucket;
};

export type UdhaarReport = {
  totalOwed: number;
  count: number;
  buckets: { key: AgeBucket; total: number; count: number }[];
  top: UdhaarRow[];
  rows: UdhaarRow[];
};

export type StaffReportRow = {
  staffId: string;
  name: string;
  bills: number;
  sold: number;
  discounts: number;
  refunds: number;
  refunded: number;
  voids: number;
  voided: number;
  netSold: number;
};

export type DayCloseReportRow = {
  close: SyncedRow;
  deviceName: string;
  staffName: string;
};

export type DayCloseReport = {
  rows: DayCloseReportRow[];
  expected: number;
  counted: number;
  difference: number;
  shortCount: number;
  shortTotal: number;
  overCount: number;
  overTotal: number;
};

export type ExpenseReportRow = {
  category: MasterRow | null;
  amount: number;
  shareBp: number;
};

export type ExpenseReport = {
  total: number;
  rows: ExpenseReportRow[];
};

export type ReportBundle = {
  range: ReportRange;
  summary: ReportSummary;
  products: ProductReports;
  stock: StockReport;
  udhaar: UdhaarReport;
  staff: StaffReportRow[];
  dayCloses: DayCloseReport;
  expenses: ExpenseReport;
  taxEnabled: boolean;
};

export type ReportOptions = {
  now?: number;
  today?: string;
  timeZone?: string;
  /**
   * Only the sales aggregation (summary, daily, hourly). The worker uses this for the
   * previous-period comparison, which renders one number and needs no stock or party scans.
   */
  summaryOnly?: boolean;
  /** Defaults to true; the Reports tabs other than Products set false. */
  slowMovers?: boolean;
};

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every business date in the inclusive range, oldest first. */
export function reportDays(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [];
  const days: string[] = [];
  for (let at = start; at <= end; at += DAY) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

function inRange(row: SyncedRow, range: ReportRange): boolean {
  if (
    range.deviceId !== undefined &&
    String(row.device_id ?? '') !== range.deviceId
  )
    return false;
  return true;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id !== ''))];
}

async function byIds<T extends { id: string }>(
  table: Table<T, string>,
  ids: readonly string[],
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const list = unique(ids);
  // `bulkGet` is one native request for a whole key array. The old "scan above
  // 200 ids" rule (D-119) was measured against one index range per key, not a
  // bulk get, and turned a report over a lifetime `sale_lines` table into a full
  // scan of every line the shop ever wrote (D-231).
  for (let at = 0; at < list.length; at += CHUNK) {
    const rows = await table.bulkGet(list.slice(at, at + CHUNK));
    for (const row of rows) if (row) out.set(row.id, row);
  }
  return out;
}

async function byAnyOf<T>(
  table: Table<T, string>,
  index: string,
  ids: readonly string[],
): Promise<T[]> {
  const list = unique(ids);
  if (list.length === 0) return [];
  // Bounded to the page/range being reported; never fall back to a table scan.
  const out: T[] = [];
  for (let at = 0; at < list.length; at += 100) {
    const chunk = list.slice(at, at + 100);
    out.push(...(await table.where(index).anyOf(chunk).toArray()));
  }
  return out;
}

function emptyMix(): PaymentMix {
  return { cash: 0, card: 0, bank_wallet: 0, udhaar: 0 };
}

function addMix(target: PaymentMix, method: string, amount: number): void {
  if (method === 'cash' || method === 'card' || method === 'bank_wallet')
    target[method] += amount;
}

function compareLedger(a: SyncedRow, b: SyncedRow): number {
  return (
    n(a.created_at) - n(b.created_at) ||
    String(a.id).localeCompare(String(b.id))
  );
}

type ProductAgg = {
  name: string;
  sku: string;
  productId: string | null;
  qty: number;
  revenue: number;
  cost: number;
};

function productKey(line: SyncedRow): string {
  return line.product_id
    ? String(line.product_id)
    : `quick:${String(line.name_snapshot ?? '')}`;
}

function addProductLine(
  agg: Map<string, ProductAgg>,
  line: SyncedRow,
  qty: number,
  revenue: number,
  cost: number,
): void {
  const key = productKey(line);
  const row = agg.get(key) ?? {
    name: String(line.name_snapshot ?? ''),
    sku: String(line.sku_snapshot ?? ''),
    productId: line.product_id ? String(line.product_id) : null,
    qty: 0,
    revenue: 0,
    cost: 0,
  };
  row.qty += qty;
  row.revenue += revenue;
  row.cost += cost;
  agg.set(key, row);
}

/** Placeholders for a summary-only bundle; no screen renders them. */
function emptySections(): Pick<
  ReportBundle,
  'products' | 'stock' | 'udhaar' | 'staff' | 'dayCloses' | 'expenses'
> {
  return {
    products: {
      rows: [],
      bestByQty: [],
      bestByRevenue: [],
      bestByProfit: [],
      categories: [],
      brands: [],
      slowMovers: [],
    },
    stock: {
      value: 0,
      items: [],
      lowStock: [],
      outOfStock: [],
      negativeStock: [],
      attention: [],
      movements: [],
      supplierReturns: { count: 0, credit: 0, difference: 0, rows: [] },
    },
    udhaar: { totalOwed: 0, count: 0, buckets: [], top: [], rows: [] },
    staff: [],
    dayCloses: {
      rows: [],
      expected: 0,
      counted: 0,
      difference: 0,
      shortCount: 0,
      shortTotal: 0,
      overCount: 0,
      overTotal: 0,
    },
    expenses: { total: 0, rows: [] },
  };
}

/** All report tabs for one range, computed on the device from Dexie (screens/16). */
export async function reportBundle(
  db: BikriDb,
  requestedRange: ReportRange,
  options: ReportOptions = {},
): Promise<ReportBundle> {
  const now = options.now ?? Date.now();
  const today = options.today ?? businessDate(now);
  // Clamp a mistyped year to the shop's real history before building day buckets
  // (review M4). The returned range is the one the bundle actually used.
  const range = clampReportRange(
    requestedRange,
    await firstBusinessDay(db),
    today,
  ).range;
  const days = reportDays(range.from, range.to);
  const dayMap = new Map<string, DailyPoint>();
  for (const date of days)
    dayMap.set(date, {
      date,
      sold: 0,
      bills: 0,
      grossProfit: 0,
      expenses: 0,
      netProfit: 0,
      tax: 0,
      udhaarGiven: 0,
      udhaarReceived: 0,
      mix: emptyMix(),
    });

  const hourly: HourlyPoint[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    sold: 0,
    bills: 0,
  }));
  const timeZone = isTimeZone(options.timeZone)
    ? options.timeZone
    : 'Asia/Karachi';
  const hourFormat = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hour12: false,
    timeZone,
  });
  const hourOf = (at: unknown) => Number(hourFormat.format(n(at))) % 24;
  // A backdated sale is recorded on a later day; its `created_at` hour belongs to the
  // recording day, not the business date. Keep it in the daily total but out of the
  // selected day's hourly chart. A cached formatter keeps the 20k-bill report fast.
  const dayFormat = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  });
  const singleDay = days.length === 1;
  const onBusinessDay = (at: unknown, business: unknown) =>
    !singleDay || dayFormat.format(n(at)) === String(business);

  const productAgg = new Map<string, ProductAgg>();
  const staffAgg = new Map<string, StaffReportRow>();
  const expenseTotals = new Map<string, number>();
  let revenue = 0;
  let refundCount = 0;
  let refunded = 0;

  // One calendar month at a time: a multi-year report must not keep every sale, line,
  // payment and refund in memory at once (review M4).
  for (const chunk of monthChunks(range.from, range.to)) {
    const sales = (
      await db.sales
        .where('business_date')
        .between(chunk.from, chunk.to, true, true)
        .toArray()
    ).filter((sale) => inRange(sale, range) && sale.status !== 'void');
    const saleById = new Map(sales.map((sale) => [sale.id, sale]));
    const saleLines = (
      await db.sale_lines
        .where('business_date')
        .between(chunk.from, chunk.to, true, true)
        .toArray()
    ).filter((line) => saleById.has(String(line.sale_id)));
    const linesBySale = new Map<string, SyncedRow[]>();
    for (const line of saleLines) {
      const key = String(line.sale_id);
      const list = linesBySale.get(key) ?? [];
      list.push(line);
      linesBySale.set(key, list);
    }

    for (const sale of sales) {
      const day = dayMap.get(String(sale.business_date));
      if (!day) continue;
      day.sold += n(sale.total);
      day.bills += 1;
      day.tax += n(sale.tax);
      const hour = onBusinessDay(sale.created_at, sale.business_date)
        ? hourly[hourOf(sale.created_at)]
        : undefined;
      if (hour) {
        hour.sold += n(sale.total);
        hour.bills += 1;
      }
      const udhaar = n(sale.udhaar_amount);
      day.udhaarGiven += udhaar;
      day.mix.udhaar += udhaar;
      const staff = staffRowFor(staffAgg, String(sale.staff_id));
      staff.bills += 1;
      staff.sold += n(sale.total);
      // The bundle allocation residual is not a staff discount (07 §3.1).
      let bundleResidual = 0;
      for (const line of linesBySale.get(sale.id) ?? []) {
        if (line.bundle_id) bundleResidual += n(line.discount);
      }
      staff.discounts +=
        n(sale.item_discount_total) -
        bundleResidual +
        n(sale.bill_discount) +
        n(sale.bundle_discount_total);
      const taxInclusive = sale.tax_inclusive === 1;
      for (const line of linesBySale.get(sale.id) ?? []) {
        const lineRevenueValue = lineRevenue(line, taxInclusive);
        const lineCost = mulDivRound(
          n(line.qty_milli),
          n(line.unit_cost_snapshot),
          1000,
        );
        day.grossProfit += lineRevenueValue - lineCost;
        revenue += lineRevenueValue;
        addProductLine(
          productAgg,
          line,
          n(line.qty_milli),
          lineRevenueValue,
          lineCost,
        );
      }
    }

    const refunds = (
      await db.refunds
        .where('business_date')
        .between(chunk.from, chunk.to, true, true)
        .toArray()
    ).filter((refund) => inRange(refund, range));
    if (refunds.length > 0) {
      const refundById = new Map(refunds.map((refund) => [refund.id, refund]));
      const refundIds = new Set(refunds.map((refund) => String(refund.id)));
      const refundLines = (
        await db.refund_lines
          .where('business_date')
          .between(chunk.from, chunk.to, true, true)
          .toArray()
      ).filter((line) => refundIds.has(String(line.refund_id)));
      const touchedLineIds = unique(
        refundLines.map((line) => String(line.sale_line_id)),
      );
      const relatedRefundLines = await byAnyOf(
        db.refund_lines,
        'sale_line_id',
        touchedLineIds,
      );
      const originalLines = await byIds(db.sale_lines, touchedLineIds);
      const originalSaleIds = unique(
        [...originalLines.values()].map((line) => String(line.sale_id)),
      ).filter((id) => !saleById.has(id));
      const originalSales = await byIds(db.sales, originalSaleIds);

      for (const refund of refunds) {
        const day = dayMap.get(String(refund.business_date));
        if (!day) continue;
        const money = n(refund.amount);
        const khata = n(refund.udhaar_part);
        day.sold -= money + khata;
        const refundHour = onBusinessDay(
          refund.created_at,
          refund.business_date,
        )
          ? hourly[hourOf(refund.created_at)]
          : undefined;
        if (refundHour) refundHour.sold -= money + khata;
        day.udhaarGiven -= khata;
        day.mix.udhaar -= khata;
        addMix(day.mix, String(refund.method ?? ''), -money);
        refundCount += 1;
        refunded += money + khata;
        const staff = staffRowFor(staffAgg, String(refund.staff_id));
        staff.refunds += 1;
        staff.refunded += money + khata;
      }

      const allRefundLinesBySaleLine = new Map<string, SyncedRow[]>();
      for (const line of relatedRefundLines) {
        const key = String(line.sale_line_id);
        const list = allRefundLinesBySaleLine.get(key) ?? [];
        list.push(line);
        allRefundLinesBySaleLine.set(key, list);
      }
      for (const [lineId, refundLinesForLine] of allRefundLinesBySaleLine) {
        const line = originalLines.get(lineId);
        if (!line) continue;
        const sale =
          saleById.get(String(line.sale_id)) ??
          originalSales.get(String(line.sale_id));
        if (!sale) continue;
        const taxInclusive = sale.tax_inclusive === 1;
        const lineRevenueValue = lineRevenue(line, taxInclusive);
        const soldQty = n(line.qty_milli);
        let previous = 0;
        for (const refundLine of [...refundLinesForLine].sort(compareLedger)) {
          const refundId = String(refundLine.refund_id);
          const qty = n(refundLine.qty_milli);
          // Count every earlier refund into `previous`, but apply only this month's
          // header: related lines can span several months.
          if (refundIds.has(refundId)) {
            const refund = refundById.get(refundId);
            const day = refund
              ? dayMap.get(String(refund.business_date))
              : undefined;
            if (refund && day) {
              const returnedRevenue = refundedRevenue(
                lineRevenueValue,
                soldQty,
                previous,
                qty,
              );
              const returnedCost = refundedCost(
                n(line.unit_cost_snapshot),
                previous,
                qty,
              );
              day.grossProfit -= returnedRevenue - returnedCost;
              day.tax -= refundedTax(n(line.tax_alloc), soldQty, previous, qty);
              revenue -= returnedRevenue;
              addProductLine(
                productAgg,
                line,
                -qty,
                -returnedRevenue,
                -returnedCost,
              );
            }
          }
          previous += qty;
        }
      }
    }

    const payments = (
      await db.payments
        .where('business_date')
        .between(chunk.from, chunk.to, true, true)
        .toArray()
    ).filter((payment) => inRange(payment, range));
    for (const payment of payments) {
      const day = dayMap.get(String(payment.business_date));
      if (!day) continue;
      const amount = n(payment.amount);
      if (payment.direction === 'in' && payment.purpose === 'sale') {
        // A voided sale is excluded from Sold and Bills; its original payment and the
        // reversing void payout must not reappear in the method mix either.
        if (payment.sale_id && saleById.has(String(payment.sale_id)))
          addMix(day.mix, String(payment.method), amount);
      } else if (
        payment.direction === 'in' &&
        payment.purpose === 'customer_payment'
      )
        day.udhaarReceived += amount;
    }

    const expenses = (
      await db.expenses
        .where('business_date')
        .between(chunk.from, chunk.to, true, true)
        .toArray()
    ).filter((expense) => inRange(expense, range));
    for (const expense of expenses) {
      const day = dayMap.get(String(expense.business_date));
      if (!day) continue;
      const amount = n(expense.amount) * (expense.reverses_id ? -1 : 1);
      day.expenses += amount;
      const category = String(expense.category_id);
      expenseTotals.set(category, (expenseTotals.get(category) ?? 0) + amount);
    }
  }

  const daily = [...dayMap.values()];
  for (const day of daily) day.netProfit = day.grossProfit - day.expenses;
  const summaryTotals = daily.reduce(
    (out, day) => {
      out.sold += day.sold;
      out.bills += day.bills;
      out.grossProfit += day.grossProfit;
      out.expenses += day.expenses;
      out.tax += day.tax;
      out.udhaarGiven += day.udhaarGiven;
      out.udhaarReceived += day.udhaarReceived;
      for (const method of ['cash', 'card', 'bank_wallet', 'udhaar'] as const)
        out.paymentMix[method] += day.mix[method];
      return out;
    },
    {
      sold: 0,
      bills: 0,
      grossProfit: 0,
      expenses: 0,
      tax: 0,
      udhaarGiven: 0,
      udhaarReceived: 0,
      paymentMix: emptyMix(),
    },
  );
  const summary: ReportSummary = {
    ...summaryTotals,
    avgBill:
      summaryTotals.bills > 0
        ? mulDivRound(summaryTotals.sold, 1, summaryTotals.bills)
        : 0,
    netProfit: summaryTotals.grossProfit - summaryTotals.expenses,
    marginBp:
      revenue > 0 ? mulDivRound(summaryTotals.grossProfit, 10000, revenue) : 0,
    refunded,
    refundCount,
    daily,
    hourly,
  };

  const shop = await db.shop.get('shop');
  const taxEnabled = n(shop?.tax_rate_bp) > 0 || summary.tax !== 0;
  if (options.summaryOnly)
    return {
      range,
      summary,
      ...emptySections(),
      taxEnabled,
    };
  const [products, stock] = await Promise.all([
    productReports(db, {
      agg: productAgg,
      today,
      withSlowMovers: options.slowMovers !== false,
    }),
    stockReport(db, range),
  ]);
  const [udhaar, staff, dayCloses, expenseReport] = await Promise.all([
    udhaarReport(db, { now, today }),
    staffReport(db, { range, staff: staffAgg }),
    dayCloseReport(db, range),
    expenseReportFor(db, expenseTotals),
  ]);
  return {
    range,
    summary,
    products,
    stock,
    udhaar,
    staff,
    dayCloses,
    expenses: expenseReport,
    taxEnabled,
  };
}

async function productReports(
  db: BikriDb,
  input: {
    agg: Map<string, ProductAgg>;
    today: string;
    withSlowMovers: boolean;
  },
): Promise<ProductReports> {
  const agg = input.agg;
  const productIds = [...agg.values()]
    .map((row) => row.productId)
    .filter((id): id is string => id !== null);
  const productRows = await byIds(db.products, productIds);
  const categories = (await db.categories.toArray()).filter(
    (category) => !category.deleted_at,
  );
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const rows: ProductReportRow[] = [...agg].map(([key, row]) => {
    const product = row.productId ? productRows.get(row.productId) : undefined;
    return {
      key,
      productId: row.productId,
      name: product ? String(product.name_en) : row.name,
      nameUr: product ? String(product.name_ur ?? '') : '',
      sku: product ? String(product.sku) : row.sku,
      unit: product ? String(product.unit ?? 'pc') : 'pc',
      categoryId: product?.category_id ? String(product.category_id) : null,
      brand: product ? String(product.brand ?? '') : '',
      qtyMilli: row.qty,
      revenue: row.revenue,
      cost: row.cost,
      profit: row.revenue - row.cost,
    };
  });
  const categoryRows = new Map<string, GroupReportRow>();
  const brandRows = new Map<string, GroupReportRow>();
  for (const row of rows) {
    const category = row.categoryId
      ? categoryById.get(row.categoryId)
      : undefined;
    const categoryKey = row.categoryId ?? 'none';
    const categoryRow = categoryRows.get(categoryKey) ?? {
      key: categoryKey,
      name: category ? String(category.name_en) : '',
      nameUr: category ? String(category.name_ur ?? '') : '',
      qtyMilli: 0,
      revenue: 0,
      cost: 0,
      profit: 0,
    };
    categoryRow.qtyMilli += row.qtyMilli;
    categoryRow.revenue += row.revenue;
    categoryRow.cost += row.cost;
    categoryRow.profit += row.profit;
    categoryRows.set(categoryKey, categoryRow);

    const brandKey = row.brand.trim();
    const brandRow = brandRows.get(brandKey) ?? {
      key: brandKey,
      name: brandKey,
      nameUr: '',
      qtyMilli: 0,
      revenue: 0,
      cost: 0,
      profit: 0,
    };
    brandRow.qtyMilli += row.qtyMilli;
    brandRow.revenue += row.revenue;
    brandRow.cost += row.cost;
    brandRow.profit += row.profit;
    brandRows.set(brandKey, brandRow);
  }

  const slowMovers = input.withSlowMovers
    ? await slowMoversReport(db, input.today)
    : [];

  const byQty = [...rows]
    .filter((row) => row.qtyMilli > 0)
    .sort((a, b) => b.qtyMilli - a.qtyMilli)
    .slice(0, 10);
  const byRevenue = [...rows]
    .filter((row) => row.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);
  const byProfit = [...rows].sort((a, b) => b.profit - a.profit).slice(0, 10);
  return {
    rows: rows.sort((a, b) => b.revenue - a.revenue),
    bestByQty: byQty,
    bestByRevenue: byRevenue,
    bestByProfit: byProfit,
    categories: [...categoryRows.values()]
      .filter((row) => row.qtyMilli !== 0 || row.revenue !== 0)
      .sort((a, b) => b.revenue - a.revenue),
    brands: [...brandRows.values()]
      .filter((row) => row.qtyMilli !== 0 || row.revenue !== 0)
      .sort((a, b) => b.revenue - a.revenue),
    slowMovers,
  };
}

/**
 * Products with stock that have not sold for 30 days. The recent window is read from
 * the `sale_lines.business_date` index; only the few candidates left after that are
 * probed one at a time with the `[product_id+business_date]` index. Walking every
 * movement the shop ever wrote blocked the counter for seconds (fifth review P0).
 */
export async function slowMoversReport(
  db: BikriDb,
  today: string,
): Promise<SlowMover[]> {
  const slowCutoff = addDays(today, -30);
  const products = (
    await db.products.where('track_stock').equals(1).toArray()
  ).filter((product) => !product.deleted_at);
  const [levelRows, voidRows] = await Promise.all([
    db.stock_levels.bulkGet(products.map((product) => String(product.id))),
    db.sale_voids.toArray(),
  ]);
  const levels = new Map(
    levelRows
      .filter(
        (level): level is { product_id: string; on_hand_milli: number } =>
          level !== undefined,
      )
      .map((level) => [level.product_id, level.on_hand_milli]),
  );
  const voided = new Set(voidRows.map((row) => String(row.sale_id)));
  // One bounded range over the last 30 business days. A sale voided after a sync is
  // excluded here, and the per-product probe below skips it too. `toArray` is much
  // faster than one cursor step per row on fake-indexeddb/older WebViews; the range
  // is bounded by 30 days, not by the shop's lifetime.
  const recentLines = await db.sale_lines
    .where('business_date')
    .between(addDays(today, -29), today, true, true)
    .toArray();
  const soldRecently = new Set<string>();
  for (const line of recentLines) {
    if (!line.product_id || voided.has(String(line.sale_id))) continue;
    soldRecently.add(String(line.product_id));
  }
  const candidates = products.filter(
    (product) =>
      (levels.get(String(product.id)) ?? 0) > 0 &&
      !soldRecently.has(String(product.id)),
  );
  const rows = await Promise.all(
    candidates.map(async (product): Promise<SlowMover> => {
      const id = String(product.id);
      // Newest first; the compound index makes this one bounded reverse seek and
      // the filter stops at the first non-voided sale (voids are rare).
      const last = await db.sale_lines
        .where('[product_id+business_date]')
        .between([id, ''], [id, '\uffff'], true, true)
        .reverse()
        .filter((line) => !voided.has(String(line.sale_id)))
        .first();
      return {
        product,
        onHand: levels.get(id) ?? 0,
        lastSale:
          last && typeof last.business_date === 'string'
            ? last.business_date
            : null,
      };
    }),
  );
  return rows
    .filter((row) => row.lastSale === null || row.lastSale <= slowCutoff)
    .sort(
      (a, b) =>
        String(a.lastSale ?? '').localeCompare(String(b.lastSale ?? '')) ||
        String(a.product.name_en).localeCompare(String(b.product.name_en)),
    );
}

async function stockReport(
  db: BikriDb,
  range: ReportRange,
): Promise<StockReport> {
  const products = (await db.products.toArray()).filter(
    (product) => !product.deleted_at,
  );
  const levels = new Map(
    (
      await db.stock_levels.bulkGet(
        products.map((product) => String(product.id)),
      )
    )
      .filter(
        (level): level is { product_id: string; on_hand_milli: number } =>
          level !== undefined,
      )
      .map((level) => [level.product_id, level.on_hand_milli]),
  );
  const items: StockItem[] = [];
  for (const product of products) {
    if (product.track_stock !== 1) continue;
    const onHand = levels.get(String(product.id)) ?? 0;
    const min = n(product.min_stock_milli);
    const status: StockItem['status'] =
      onHand < 0
        ? 'negative'
        : onHand === 0
          ? 'out'
          : min > 0 && onHand <= min
            ? 'low'
            : 'ok';
    items.push({
      product,
      onHand,
      value: onHand > 0 ? mulDivRound(onHand, n(product.avg_cost), 1000) : 0,
      status,
    });
  }
  const lowStock = items
    .filter((row) => row.status === 'low')
    .sort((a, b) => a.onHand - b.onHand);
  const outOfStock = items
    .filter((row) => row.status === 'out')
    .sort((a, b) =>
      String(a.product.name_en).localeCompare(String(b.product.name_en)),
    );
  const negativeStock = items
    .filter((row) => row.status === 'negative')
    .sort((a, b) => a.onHand - b.onHand);
  const value = products
    .filter((product) => product.track_stock === 1)
    .reduce((total, product) => {
      const onHand = levels.get(String(product.id)) ?? 0;
      return (
        total +
        (onHand > 0 ? mulDivRound(onHand, n(product.avg_cost), 1000) : 0)
      );
    }, 0);

  const movementMap = new Map<string, MovementSummaryRow>();
  const movements = (
    await db.stock_movements
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).filter((movement) => inRange(movement, range));
  for (const movement of movements) {
    const reason = String(movement.reason_code);
    const row = movementMap.get(reason) ?? {
      reason,
      count: 0,
      inQty: 0,
      outQty: 0,
      netQty: 0,
    };
    const delta = n(movement.qty_delta_milli);
    row.count += 1;
    row.inQty += Math.max(delta, 0);
    row.outQty += Math.max(-delta, 0);
    row.netQty += delta;
    movementMap.set(reason, row);
  }

  const returns = (
    await db.supplier_returns
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).filter((row) => inRange(row, range));
  const returnLines = await byAnyOf(
    db.supplier_return_lines,
    'return_id',
    returns.map((row) => row.id),
  );
  const lineTotals = new Map<string, number>();
  const lineCounts = new Map<string, number>();
  for (const line of returnLines) {
    const key = String(line.return_id);
    lineTotals.set(
      key,
      (lineTotals.get(key) ?? 0) +
        mulDivRound(n(line.qty_milli), n(line.cost_snapshot), 1000),
    );
    lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
  }
  const supplierIds = unique(returns.map((row) => String(row.supplier_id)));
  const suppliers = await byIds(db.suppliers, supplierIds);
  const returnRows: SupplierReturnRow[] = returns.map((row) => ({
    id: row.id,
    date: String(row.business_date),
    supplierId: String(row.supplier_id),
    supplierName: String(suppliers.get(String(row.supplier_id))?.name ?? ''),
    lineCount: lineCounts.get(row.id) ?? n(row.line_count),
    total: n(row.total),
    difference: n(row.total) - (lineTotals.get(row.id) ?? 0),
  }));
  return {
    value,
    items: items.sort((a, b) =>
      String(a.product.name_en).localeCompare(String(b.product.name_en)),
    ),
    lowStock,
    outOfStock,
    negativeStock,
    attention: [...negativeStock, ...outOfStock, ...lowStock],
    movements: [...movementMap.values()].sort(
      (a, b) => Math.abs(b.netQty) - Math.abs(a.netQty),
    ),
    supplierReturns: {
      count: returns.length,
      credit: returns.reduce((total, row) => total + n(row.total), 0),
      difference: returnRows.reduce((total, row) => total + row.difference, 0),
      rows: returnRows.sort((a, b) => b.date.localeCompare(a.date)),
    },
  };
}

async function udhaarReport(
  db: BikriDb,
  options: { now: number; today: string },
): Promise<UdhaarReport> {
  const balances = await db.party_balances
    .where('[party_type+party_id]')
    .between(['customer', ''], ['customer', '\uffff'])
    .toArray();
  const customers = await byIds(
    db.customers,
    balances.map((balance) => balance.party_id),
  );
  const promises = (await db.promises.toArray())
    .filter((promise) => !promise.deleted_at && promise.status === 'open')
    .sort((a, b) => String(a.promised_on).localeCompare(String(b.promised_on)));
  const promiseByCustomer = new Map<string, SyncedRow>();
  for (const promise of promises) {
    const key = String(promise.customer_id);
    if (!promiseByCustomer.has(key)) promiseByCustomer.set(key, promise);
  }
  const rows: UdhaarRow[] = [];
  for (const balance of balances) {
    const customer = customers.get(balance.party_id);
    if (!customer || balance.balance <= 0) continue;
    const promise = promiseByCustomer.get(balance.party_id);
    const promiseDate = promise ? String(promise.promised_on) : null;
    const ageDays =
      balance.oldest_unpaid_at === null
        ? 0
        : Math.max(
            0,
            Math.floor((options.now - balance.oldest_unpaid_at) / DAY),
          );
    const bucket: AgeBucket =
      promiseDate !== null && promiseDate <= options.today
        ? 'promise'
        : ageDays <= 7
          ? '0-7'
          : ageDays <= 30
            ? '8-30'
            : ageDays <= 60
              ? '31-60'
              : '60+';
    rows.push({
      customer,
      balance: balance.balance,
      ageDays,
      promiseDate,
      bucket,
    });
  }
  rows.sort((a, b) => b.balance - a.balance);
  const bucketKeys: AgeBucket[] = ['promise', '0-7', '8-30', '31-60', '60+'];
  const buckets = bucketKeys.map((key) => {
    const matching = rows.filter((row) => row.bucket === key);
    return {
      key,
      total: matching.reduce((total, row) => total + row.balance, 0),
      count: matching.length,
    };
  });
  return {
    totalOwed: rows.reduce((total, row) => total + row.balance, 0),
    count: rows.length,
    buckets,
    top: rows.slice(0, 10),
    rows,
  };
}

function staffRowFor(
  staff: Map<string, StaffReportRow>,
  staffId: string,
): StaffReportRow {
  const row = staff.get(staffId) ?? {
    staffId,
    name: '',
    bills: 0,
    sold: 0,
    discounts: 0,
    refunds: 0,
    refunded: 0,
    voids: 0,
    voided: 0,
    netSold: 0,
  };
  staff.set(staffId, row);
  return row;
}

async function staffReport(
  db: BikriDb,
  input: { range: ReportRange; staff: Map<string, StaffReportRow> },
): Promise<StaffReportRow[]> {
  const voids = (await db.sale_voids.toArray()).filter(
    (row) =>
      String(row.business_date) >= input.range.from &&
      String(row.business_date) <= input.range.to &&
      inRange(row, input.range),
  );
  const voidedSales = await byIds(
    db.sales,
    voids.map((row) => String(row.sale_id)),
  );
  for (const voidRow of voids) {
    const row = staffRowFor(input.staff, String(voidRow.staff_id));
    row.voids += 1;
    row.voided += n(voidedSales.get(String(voidRow.sale_id))?.total);
  }
  const staff = await byIds(db.staff, [...input.staff.keys()]);
  for (const row of input.staff.values()) {
    row.name = String(staff.get(row.staffId)?.name ?? '');
    row.netSold = row.sold - row.refunded;
  }
  return [...input.staff.values()]
    .filter(
      (row) =>
        row.bills + row.refunds + row.voids > 0 ||
        row.sold !== 0 ||
        row.refunded !== 0,
    )
    .sort((a, b) => b.sold - a.sold || a.name.localeCompare(b.name));
}

async function dayCloseReport(
  db: BikriDb,
  range: ReportRange,
): Promise<DayCloseReport> {
  const closes = (
    await db.day_closes
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).filter((row) => inRange(row, range));
  const devices = await byIds(
    db.devices,
    unique(closes.map((row) => String(row.device_id))),
  );
  const staff = await byIds(
    db.staff,
    unique(closes.map((row) => String(row.staff_id))),
  );
  const rows: DayCloseReportRow[] = closes
    .map((close) => ({
      close,
      deviceName: String(
        devices.get(String(close.device_id))?.name ??
          devices.get(String(close.device_id))?.code ??
          '',
      ),
      staffName: String(staff.get(String(close.staff_id))?.name ?? ''),
    }))
    .sort(
      (a, b) =>
        String(b.close.business_date).localeCompare(
          String(a.close.business_date),
        ) || n(b.close.created_at) - n(a.close.created_at),
    );
  const difference = rows.reduce(
    (total, row) => total + n(row.close.difference),
    0,
  );
  const shortRows = rows.filter((row) => n(row.close.difference) < 0);
  const overRows = rows.filter((row) => n(row.close.difference) > 0);
  return {
    rows,
    expected: rows.reduce(
      (total, row) => total + n(row.close.expected_cash),
      0,
    ),
    counted: rows.reduce((total, row) => total + n(row.close.counted_cash), 0),
    difference,
    shortCount: shortRows.length,
    shortTotal: shortRows.reduce(
      (total, row) => total + Math.abs(n(row.close.difference)),
      0,
    ),
    overCount: overRows.length,
    overTotal: overRows.reduce(
      (total, row) => total + n(row.close.difference),
      0,
    ),
  };
}

async function expenseReportFor(
  db: BikriDb,
  totals: Map<string, number>,
): Promise<ExpenseReport> {
  const categories = await byIds(db.expense_categories, [...totals.keys()]);
  const total = [...totals.values()].reduce(
    (sumValue, value) => sumValue + value,
    0,
  );
  return {
    total,
    rows: [...totals]
      .filter(([, amount]) => amount !== 0)
      .map(([id, amount]) => ({
        category: categories.get(id) ?? null,
        amount,
        shareBp: total > 0 ? mulDivRound(amount, 10000, total) : 0,
      }))
      .sort((a, b) => b.amount - a.amount),
  };
}
