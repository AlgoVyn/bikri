import {
  businessDate,
  mulDivRound,
  refundedCost,
  refundedRevenue,
  refundedTax,
} from '@bikri/core';
import type { BikriDb, MasterRow, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import { lineRevenue, type ReportRange } from './reports.ts';

const DAY = 86_400_000;
const n = (v: unknown): number => Number(v ?? 0);
const CHUNK = 2_000;
/** Above this many keys, one table scan beats thousands of index lookups (D-119). */
const SCAN_ABOVE = 200;

export type PaymentMix = {
  cash: number;
  card: number;
  bank_wallet: number;
  udhaar: number;
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
};

function addDays(date: string, days: number): string {
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
    if (days.length > 366) throw new RangeError('report range is too long');
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
  if (list.length > SCAN_ABOVE) {
    const wanted = new Set(list);
    for (const row of await table.toArray())
      if (wanted.has(row.id)) out.set(row.id, row);
    return out;
  }
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
  if (list.length > SCAN_ABOVE) {
    const wanted = new Set(list);
    return (await table.toArray()).filter((row) =>
      wanted.has(String((row as Record<string, unknown>)[index] ?? '')),
    );
  }
  const out: T[] = [];
  for (let at = 0; at < list.length; at += CHUNK) {
    const chunk = list.slice(at, at + CHUNK);
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

/** All report tabs for one range, computed on the device from Dexie (screens/16). */
export async function reportBundle(
  db: BikriDb,
  range: ReportRange,
  options: ReportOptions = {},
): Promise<ReportBundle> {
  const now = options.now ?? Date.now();
  const today = options.today ?? businessDate(now);
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

  const sales = (
    await db.sales
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).filter((sale) => inRange(sale, range) && sale.status !== 'void');
  const saleById = new Map(sales.map((sale) => [sale.id, sale]));
  const saleIds = sales.map((sale) => sale.id);
  const saleLines = await byAnyOf(db.sale_lines, 'sale_id', saleIds);
  const linesBySale = new Map<string, SyncedRow[]>();
  for (const line of saleLines) {
    const key = String(line.sale_id);
    const list = linesBySale.get(key) ?? [];
    list.push(line);
    linesBySale.set(key, list);
  }

  const refunds = (
    await db.refunds
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).filter((refund) => inRange(refund, range));
  const refundById = new Map(refunds.map((refund) => [refund.id, refund]));
  const refundIds = refunds.map((refund) => refund.id);
  const refundLines = await byAnyOf(db.refund_lines, 'refund_id', refundIds);
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
  const extraRefundIds = unique(
    relatedRefundLines.map((line) => String(line.refund_id)),
  ).filter((id) => !refundById.has(id));
  for (const [id, refund] of await byIds(db.refunds, extraRefundIds))
    refundById.set(id, refund);

  let revenue = 0;
  let refundCount = 0;
  let refunded = 0;
  const productAgg = new Map<string, ProductAgg>();
  for (const sale of sales) {
    const day = dayMap.get(String(sale.business_date));
    if (!day) continue;
    day.sold += n(sale.total);
    day.bills += 1;
    day.tax += n(sale.tax);
    const udhaar = n(sale.udhaar_amount);
    day.udhaarGiven += udhaar;
    day.mix.udhaar += udhaar;
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

  // Refunds count on their own business date; profit and tax reverse with the cumulative
  // per-line pattern so repeated partial refunds never drift (07 §6, §9).
  const allRefundLinesBySaleLine = new Map<string, SyncedRow[]>();
  for (const line of relatedRefundLines) {
    const key = String(line.sale_line_id);
    const list = allRefundLinesBySaleLine.get(key) ?? [];
    list.push(line);
    allRefundLinesBySaleLine.set(key, list);
  }
  for (const refund of refunds) {
    const day = dayMap.get(String(refund.business_date));
    if (!day) continue;
    const money = n(refund.amount);
    const khata = n(refund.udhaar_part);
    day.sold -= money + khata;
    day.udhaarGiven -= khata;
    day.mix.udhaar -= khata;
    addMix(day.mix, String(refund.method ?? ''), -money);
    refundCount += 1;
    refunded += money + khata;
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
      const refund = refundById.get(String(refundLine.refund_id));
      const qty = n(refundLine.qty_milli);
      if (refund && inRange(refund, range)) {
        const day = dayMap.get(String(refund.business_date));
        if (day) {
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

  const payments = (
    await db.payments
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).filter((payment) => inRange(payment, range));
  for (const payment of payments) {
    const day = dayMap.get(String(payment.business_date));
    if (!day) continue;
    const amount = n(payment.amount);
    if (payment.direction === 'in' && payment.purpose === 'sale')
      addMix(day.mix, String(payment.method), amount);
    else if (payment.direction === 'out' && payment.purpose === 'void')
      addMix(day.mix, String(payment.method), -amount);
    if (payment.direction === 'in' && payment.purpose === 'customer_payment')
      day.udhaarReceived += amount;
  }

  const expenses = (
    await db.expenses
      .where('business_date')
      .between(range.from, range.to, true, true)
      .toArray()
  ).filter((expense) => inRange(expense, range));
  for (const expense of expenses) {
    const day = dayMap.get(String(expense.business_date));
    if (!day) continue;
    day.expenses += n(expense.amount) * (expense.reverses_id ? -1 : 1);
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
  };

  const [products, stock] = await Promise.all([
    productReports(db, { agg: productAgg, today }),
    stockReport(db, range),
  ]);
  const [udhaar, staff, dayCloses, expenseReport] = await Promise.all([
    udhaarReport(db, { now, today }),
    staffReport(db, { range, sales, refunds, voidRows: undefined }),
    dayCloseReport(db, range),
    expenseReportFor(db, { range, expenses }),
  ]);
  const shop = await db.shop.get('shop');
  return {
    range,
    summary,
    products,
    stock,
    udhaar,
    staff,
    dayCloses,
    expenses: expenseReport,
    taxEnabled: n(shop?.tax_rate_bp) > 0 || summary.tax !== 0,
  };
}

async function productReports(
  db: BikriDb,
  input: { agg: Map<string, ProductAgg>; today: string },
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

  const allProducts = (await db.products.toArray()).filter(
    (product) => !product.deleted_at,
  );
  const levels = new Map(
    (
      await db.stock_levels.bulkGet(
        allProducts.map((product) => String(product.id)),
      )
    )
      .filter(
        (level): level is { product_id: string; on_hand_milli: number } =>
          level !== undefined,
      )
      .map((level) => [level.product_id, level.on_hand_milli]),
  );
  const lastSales = new Map<string, string>();
  const movements = await db.stock_movements
    .where('business_date')
    .belowOrEqual(input.today)
    .toArray();
  for (const movement of movements) {
    if (movement.reason_code !== 'sale') continue;
    const productId = String(movement.product_id);
    const date = String(movement.business_date);
    if (!lastSales.has(productId) || date > String(lastSales.get(productId)))
      lastSales.set(productId, date);
  }
  const slowCutoff = addDays(input.today, -30);
  const slowMovers: SlowMover[] = allProducts
    .filter((product) => product.track_stock === 1)
    .map((product) => {
      const onHand = levels.get(String(product.id)) ?? 0;
      const lastSale = lastSales.get(String(product.id)) ?? null;
      return { product, onHand, lastSale };
    })
    .filter(
      (row) =>
        row.onHand > 0 && (row.lastSale === null || row.lastSale <= slowCutoff),
    )
    .sort(
      (a, b) =>
        String(a.lastSale ?? '').localeCompare(String(b.lastSale ?? '')) ||
        String(a.product.name_en).localeCompare(String(b.product.name_en)),
    );

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

async function staffReport(
  db: BikriDb,
  input: {
    range: ReportRange;
    sales: SyncedRow[];
    refunds: SyncedRow[];
    voidRows?: SyncedRow[];
  },
): Promise<StaffReportRow[]> {
  const voids = (input.voidRows ?? (await db.sale_voids.toArray())).filter(
    (row) =>
      String(row.business_date) >= input.range.from &&
      String(row.business_date) <= input.range.to &&
      inRange(row, input.range),
  );
  const voidedSales = await byIds(
    db.sales,
    voids.map((row) => String(row.sale_id)),
  );
  const map = new Map<string, StaffReportRow>();
  const rowFor = (staffId: string): StaffReportRow => {
    const row = map.get(staffId) ?? {
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
    map.set(staffId, row);
    return row;
  };
  for (const sale of input.sales) {
    const row = rowFor(String(sale.staff_id));
    row.bills += 1;
    row.sold += n(sale.total);
    row.discounts += n(sale.item_discount_total) + n(sale.bill_discount);
  }
  for (const refund of input.refunds) {
    const row = rowFor(String(refund.staff_id));
    row.refunds += 1;
    row.refunded += n(refund.amount) + n(refund.udhaar_part);
  }
  for (const voidRow of voids) {
    const row = rowFor(String(voidRow.staff_id));
    row.voids += 1;
    row.voided += n(voidedSales.get(String(voidRow.sale_id))?.total);
  }
  const staff = await byIds(db.staff, [...map.keys()]);
  for (const row of map.values()) {
    row.name = String(staff.get(row.staffId)?.name ?? '');
    row.netSold = row.sold - row.refunded;
  }
  return [...map.values()]
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
  input: { range: ReportRange; expenses: SyncedRow[] },
): Promise<ExpenseReport> {
  const categories = await byIds(
    db.expense_categories,
    unique(input.expenses.map((row) => String(row.category_id))),
  );
  const map = new Map<string, number>();
  for (const expense of input.expenses) {
    const key = String(expense.category_id);
    map.set(
      key,
      (map.get(key) ?? 0) + n(expense.amount) * (expense.reverses_id ? -1 : 1),
    );
  }
  const total = [...map.values()].reduce(
    (sumValue, value) => sumValue + value,
    0,
  );
  return {
    total,
    rows: [...map]
      .filter(([, amount]) => amount !== 0)
      .map(([id, amount]) => ({
        category: categories.get(id) ?? null,
        amount,
        shareBp: total > 0 ? mulDivRound(amount, 10000, total) : 0,
      }))
      .sort((a, b) => b.amount - a.amount),
  };
}
