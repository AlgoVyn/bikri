import { businessDate, mulDivRound } from '@bikri/core';
import type { MasterRow, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import { csvCell, qtyCsv, rupeesCsv } from '../lib/csv.ts';
import type { SortDirection } from '../lib/sort.ts';
import { rowsAnyOf } from './bulk.ts';
import type { TableSource } from './caches.ts';

const n = (v: unknown): number => Number(v ?? 0);
const INVOICE_COLLATOR = new Intl.Collator(undefined, { numeric: true });
const NAME_COLLATOR = new Intl.Collator();
const STATUS_RANK: Record<string, number> = {
  paid: 0,
  part_refunded: 1,
  refunded: 2,
  void: 3,
};

export type SalesPreset =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'month'
  | 'custom';

export type SaleMethod = 'cash' | 'card' | 'bank_wallet' | 'udhaar';
export type MethodFilter = SaleMethod | 'split';
export type SaleStatus = 'paid' | 'part_refunded' | 'refunded' | 'void';
export type SaleSort =
  | 'time'
  | 'invoice'
  | 'customer'
  | 'items'
  | 'total'
  | 'method'
  | 'status';

/** Natural first-click order for each sales column. */
export const SALE_SORT_DIRECTIONS: Record<SaleSort, SortDirection> = {
  time: 'desc',
  invoice: 'asc',
  customer: 'asc',
  items: 'asc',
  total: 'desc',
  method: 'asc',
  status: 'asc',
};

export function defaultSaleSortDirection(sort: SaleSort): SortDirection {
  return SALE_SORT_DIRECTIONS[sort];
}

export type SalesFilter = {
  from: string;
  to: string;
  query?: string;
  method?: MethodFilter | null;
  status?: SaleStatus | null;
  staffId?: string | null;
  deviceId?: string | null;
  /** Cashiers only see their own branch (screens/10). */
  branchId?: string | null;
  sort?: SaleSort;
  direction?: SortDirection;
};

export type SaleListRow = {
  sale: SyncedRow;
  customerName: string | null;
  customerPhone: string | null;
  staffName: string;
  deviceName: string;
  methods: SaleMethod[];
  /** Applied amounts of the sale's own payments (not tendered). */
  applied: { cash: number; card: number; bank_wallet: number };
  /** Money given back for this bill, including the part taken off the khata. */
  refunded: number;
  printFailed: boolean;
  printJobId: string | null;
  /** Lowercased invoice, customer and line names/SKUs for the in-memory search. */
  searchText: string;
  /** Customer phone digits, so "0300…" and "+92300…" both match. */
  searchDigits: string;
};

export type SalesDay = {
  date: string;
  bills: number;
  total: number;
  rows: SaleListRow[];
};

export type SalesSummary = {
  bills: number;
  sold: number;
  refunds: number;
  avgBill: number;
};

export type SalesHistory = {
  rows: SaleListRow[];
  days: SalesDay[];
  summary: SalesSummary;
};

/** Split days into pages without losing a busy day's full header totals. */
export function pageOf(days: SalesDay[], size: number): SalesDay[][] {
  const pages: SalesDay[][] = [];
  let current: SalesDay[] = [];
  let count = 0;
  const push = () => {
    if (current.length > 0) pages.push(current);
    current = [];
    count = 0;
  };
  for (const day of days) {
    if (day.rows.length > size) {
      push();
      const bills = day.rows.filter((row) => row.sale.status !== 'void').length;
      const total = day.rows.reduce(
        (sum, row) =>
          row.sale.status === 'void' ? sum : sum + Number(row.sale.total ?? 0),
        0,
      );
      for (let at = 0; at < day.rows.length; at += size) {
        const rows = day.rows.slice(at, at + size);
        pages.push([{ date: day.date, bills, total, rows }]);
      }
      continue;
    }
    if (current.length > 0 && count + day.rows.length > size) push();
    current.push(day);
    count += day.rows.length;
  }
  push();
  return pages;
}

export type SalesOption = { id: string; name: string };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive business-date range for a preset (screens/10). */
export function rangeFor(
  preset: SalesPreset,
  now: number,
  timeZone: string,
  custom?: { from: string; to: string },
): { from: string; to: string } {
  const today = businessDate(now, timeZone);
  switch (preset) {
    case 'yesterday': {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'custom':
      return custom ?? { from: today, to: today };
    default:
      return { from: today, to: today };
  }
}

function paymentRows(rows: readonly SyncedRow[]): SyncedRow[] {
  return rows.filter((p) => p.direction === 'in' && p.purpose === 'sale');
}

function methodsOf(
  sale: SyncedRow,
  payments: readonly SyncedRow[],
): SaleMethod[] {
  const methods = new Set<SaleMethod>();
  for (const p of paymentRows(payments))
    methods.add(String(p.method) as SaleMethod);
  if (n(sale.udhaar_amount) > 0) methods.add('udhaar');
  return [...methods];
}

function matchesMethod(
  methods: readonly SaleMethod[],
  filter: MethodFilter,
): boolean {
  if (filter === 'split') return methods.length > 1;
  return methods.includes(filter);
}

function saleJobs(
  jobs: readonly PrintJobLite[],
  saleId: string,
): PrintJobLite[] {
  return jobs
    .filter((j) => j.sale_id === saleId)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

function latestSaleJob(
  jobs: readonly PrintJobLite[],
  saleId: string,
): PrintJobLite | undefined {
  return saleJobs(jobs, saleId).at(-1);
}

/** A failed job stays red until a later job of the same bill succeeds (screens/10 AC 5). */
function failedPrintFor(jobs: readonly PrintJobLite[]): {
  failed: boolean;
  jobId: string | null;
} {
  let failed = false;
  let jobId: string | null = null;
  const ordered = [...jobs].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
  for (const job of ordered) {
    if (job.status === 'failed') {
      failed = true;
      jobId = job.id;
    } else if (job.status === 'done') {
      failed = false;
      jobId = null;
    }
  }
  return { failed, jobId };
}

export type PrintJobLite = {
  id: string;
  sale_id?: string;
  created_at: number;
  status: string;
};

/** Device name from the synced row, or the local `kv.device` of this till (dev/e2e shops). */
export async function deviceNameOf(
  src: TableSource,
  deviceId: string,
): Promise<string> {
  const device = await (src.table('devices') as Table<SyncedRow>).get(deviceId);
  if (device) return String(device.name ?? device.code ?? '');
  const local = (await (
    src.table('kv') as Table<{ key: string; value: unknown }>
  ).get('device')) as
    | { value?: { id?: string; name?: string; code?: string } }
    | undefined;
  const value = local?.value;
  if (value?.id !== deviceId) return '';
  return String(value.name ?? value.code ?? '');
}

/** Query text → the sale ids it matches by invoice, customer or product (screens/10). */
/** The selected range loaded once; filtering and sorting stay in memory. */
export type SalesHistoryData = {
  rows: SaleListRow[];
  rangeRefunds: SyncedRow[];
};

/** Reads the selected range once, including the line names/SKUs for search. */
export async function loadSalesHistory(
  src: TableSource,
  range: { from: string; to: string },
): Promise<SalesHistoryData> {
  const sales = await (src.table('sales') as Table<SyncedRow>)
    .where('business_date')
    .between(range.from, range.to, true, true)
    .toArray();
  const ids = sales.map((s) => s.id);
  const saleIdSet = new Set(ids);

  const paymentsById = new Map<string, SyncedRow[]>();
  if (ids.length > 0) {
    // A sale payment carries the sale's business date, so the range index reads only
    // the selected days instead of opening one index range per bill (D-119).
    const pays = (
      await (src.table('payments') as Table<SyncedRow>)
        .where('business_date')
        .between(range.from, range.to, true, true)
        .toArray()
    ).filter((p) => p.sale_id !== null && saleIdSet.has(String(p.sale_id)));
    for (const p of pays) {
      const key = String(p.sale_id);
      const list = paymentsById.get(key) ?? [];
      list.push(p);
      paymentsById.set(key, list);
    }
  }

  // Refunds count on the date they happen, so one range read serves both the bill rows
  // (money given back to this sale) and the summary. The old code read every refund from
  // the range start and then read the same range again for the summary.
  const rangeRefunds = await (src.table('refunds') as Table<SyncedRow>)
    .where('business_date')
    .between(range.from, range.to, true, true)
    .toArray();
  const refundsById = new Map<string, SyncedRow[]>();
  if (ids.length > 0) {
    for (const refund of rangeRefunds) {
      if (refund.sale_id === null || !saleIdSet.has(String(refund.sale_id)))
        continue;
      const key = String(refund.sale_id);
      const list = refundsById.get(key) ?? [];
      list.push(refund);
      refundsById.set(key, list);
    }
  }

  // A failed print is rare: read the indexed failed jobs first, then only the jobs of
  // those sales (a later `done` job supersedes the failure). An empty failure list costs
  // one index query, not 90 days of print history.
  const jobsBySale = new Map<string, PrintJobLite[]>();
  if (ids.length > 0) {
    const failed = await (src.table('print_jobs') as Table<PrintJobLite>)
      .where('status')
      .equals('failed')
      .toArray();
    const failedSaleIds = [
      ...new Set(
        failed
          .map((job) => String(job.sale_id ?? ''))
          .filter((id) => id !== '' && saleIdSet.has(id)),
      ),
    ];
    if (failedSaleIds.length > 0) {
      const jobs = await rowsAnyOf<PrintJobLite>(
        src.table('print_jobs') as Table<PrintJobLite>,
        'sale_id',
        failedSaleIds,
        (job) => String(job.sale_id),
        Number.POSITIVE_INFINITY,
      );
      for (const job of jobs) {
        const key = String(job.sale_id ?? '');
        if (!saleIdSet.has(key)) continue;
        const list = jobsBySale.get(key) ?? [];
        list.push(job);
        jobsBySale.set(key, list);
      }
    }
  }

  const customerIds = [
    ...new Set(
      sales.map((s) => s.customer_id).filter((id): id is string => !!id),
    ),
  ];
  const customers = new Map(
    (await (src.table('customers') as Table<MasterRow>).bulkGet(customerIds))
      .filter((c): c is MasterRow => c !== undefined)
      .map((c) => [c.id, c]),
  );
  const staff = new Map(
    (
      await (src.table('staff') as Table<MasterRow>).bulkGet([
        ...new Set(sales.map((s) => String(s.staff_id))),
      ])
    )
      .filter((s): s is MasterRow => s !== undefined)
      .map((s) => [s.id, s]),
  );
  const deviceIds = [...new Set(sales.map((sale) => String(sale.device_id)))];
  const deviceRows = await (
    src.table('devices') as Table<SyncedRow, string>
  ).bulkGet(deviceIds);
  const localDevice = (await (
    src.table('kv') as Table<{ key: string; value: unknown }>
  ).get('device')) as
    | { value?: { id?: string; name?: string; code?: string } }
    | undefined;
  const deviceNames = new Map<string, string>();
  deviceIds.forEach((id, index) => {
    const device = deviceRows[index];
    const local = localDevice?.value;
    deviceNames.set(
      id,
      device
        ? String(device.name ?? device.code ?? '')
        : local?.id === id
          ? String(local.name ?? local.code ?? '')
          : '',
    );
  });

  const rows: SaleListRow[] = [];
  for (const sale of sales) {
    const pays = paymentsById.get(sale.id) ?? [];
    const methods = methodsOf(sale, pays);
    const refunded = (refundsById.get(sale.id) ?? []).reduce(
      (s, r) => s + n(r.amount) + n(r.udhaar_part),
      0,
    );
    const applied = { cash: 0, card: 0, bank_wallet: 0 };
    for (const p of paymentRows(pays)) {
      const method = String(p.method);
      if (method === 'cash' || method === 'card' || method === 'bank_wallet')
        applied[method] += n(p.amount);
    }
    const customer = sale.customer_id
      ? customers.get(String(sale.customer_id))
      : undefined;
    const seller = staff.get(String(sale.staff_id));
    const print = failedPrintFor(jobsBySale.get(String(sale.id)) ?? []);
    const customerName = customer ? String(customer.name) : null;
    const customerPhone = customer?.phone ? String(customer.phone) : null;
    const searchableCustomer =
      customer && !customer.deleted_at ? customer : undefined;
    const searchText = [
      String(sale.invoice_no),
      searchableCustomer ? String(searchableCustomer.name) : '',
    ]
      .join(' ')
      .toLowerCase();
    const searchDigits = (
      searchableCustomer?.phone ? String(searchableCustomer.phone) : ''
    )
      .replace(/\D/gu, '')
      .replace(/^0+/u, '');
    rows.push({
      sale,
      customerName,
      customerPhone,
      staffName: seller ? String(seller.name) : '',
      deviceName: deviceNames.get(String(sale.device_id)) as string,
      methods,
      applied,
      refunded,
      printFailed: print.failed,
      printJobId: print.jobId,
      searchText,
      searchDigits,
    });
  }

  // Match reports: refunds count on the date they happen, not the original sale date.
  return { rows, rangeRefunds };
}

/**
 * Line names/SKUs for the selected range, loaded only when the user types a search.
 * The date is denormalised (D-228), so this is bounded by the range, not the shop's age.
 */
export async function loadSalesLineText(
  src: TableSource,
  range: { from: string; to: string },
): Promise<Map<string, string>> {
  const lineText = new Map<string, string>();
  const lines = await (src.table('sale_lines') as Table<SyncedRow>)
    .where('business_date')
    .between(range.from, range.to, true, true)
    .toArray();
  for (const line of lines) {
    const saleId = String(line.sale_id);
    const text =
      `${String(line.name_snapshot ?? '')} ${String(line.sku_snapshot ?? '')} ${String(line.bundle_name ?? '')}`
        .trim()
        .toLowerCase();
    lineText.set(saleId, `${lineText.get(saleId) ?? ''} ${text}`.trim());
  }
  return lineText;
}

/** Pure filter/sort for the loaded range: a keystroke does not touch IndexedDB. */
export function filterSalesHistory(
  data: SalesHistoryData,
  filter: SalesFilter,
  lineText?: ReadonlyMap<string, string>,
): SalesHistory {
  const q = (filter.query ?? '').trim().toLowerCase();
  const words = q.split(/\s+/u).filter(Boolean);
  const digits = q.replace(/\D/gu, '').replace(/^0+/u, '');
  let rows = data.rows
    .filter((row) => !filter.branchId || row.sale.branch_id === filter.branchId)
    .filter((row) => !filter.staffId || row.sale.staff_id === filter.staffId)
    .filter((row) => !filter.deviceId || row.sale.device_id === filter.deviceId)
    .filter((row) => !filter.status || row.sale.status === filter.status);
  if (q !== '') {
    rows = rows.filter((row) => {
      const text = `${row.searchText} ${lineText?.get(String(row.sale.id)) ?? ''}`;
      return (
        text.includes(q) ||
        (words.length > 1 && words.every((word) => text.includes(word))) ||
        (digits.length >= 3 && row.searchDigits.includes(digits))
      );
    });
  }
  if (filter.method)
    rows = rows.filter((row) =>
      matchesMethod(row.methods, filter.method ?? 'cash'),
    );

  const sort = filter.sort ?? 'time';
  const sign =
    (filter.direction ?? defaultSaleSortDirection(sort)) === 'asc' ? 1 : -1;
  const newest = (a: SaleListRow, b: SaleListRow) =>
    n(b.sale.created_at) - n(a.sale.created_at) ||
    n(b.sale.invoice_seq) - n(a.sale.invoice_seq) ||
    String(b.sale.id).localeCompare(String(a.sale.id));
  rows.sort((a, b) => {
    let value = 0;
    if (sort === 'invoice')
      value = INVOICE_COLLATOR.compare(
        String(a.sale.invoice_no),
        String(b.sale.invoice_no),
      );
    else if (sort === 'customer') {
      if (a.customerName === null || b.customerName === null) {
        if (a.customerName === null && b.customerName === null) value = 0;
        else return a.customerName === null ? 1 : -1;
      } else value = NAME_COLLATOR.compare(a.customerName, b.customerName);
    } else if (sort === 'items')
      value = n(a.sale.items_qty_milli) - n(b.sale.items_qty_milli);
    else if (sort === 'total') value = n(a.sale.total) - n(b.sale.total);
    else if (sort === 'method')
      value = NAME_COLLATOR.compare(a.methods.join(' '), b.methods.join(' '));
    else if (sort === 'status')
      value =
        (STATUS_RANK[String(a.sale.status)] ?? 9) -
        (STATUS_RANK[String(b.sale.status)] ?? 9);
    else value = n(a.sale.created_at) - n(b.sale.created_at);
    return value === 0 ? newest(a, b) : sign * value;
  });

  const byDate = new Map<string, SalesDay>();
  for (const row of rows) {
    const date = String(row.sale.business_date);
    const day = byDate.get(date);
    if (day) day.rows.push(row);
    else byDate.set(date, { date, bills: 0, total: 0, rows: [row] });
  }
  const days = [...byDate.values()].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  for (const day of days) {
    for (const row of day.rows) {
      if (row.sale.status === 'void') continue;
      day.bills += 1;
      day.total += n(row.sale.total);
    }
  }

  const live = rows.filter((r) => r.sale.status !== 'void');
  const soldGross = live.reduce((s, r) => s + n(r.sale.total), 0);
  // The summary describes the visible list: when the list is narrowed (cashier,
  // device, method, status or search), only refunds of those bills count.
  const narrowed =
    Boolean(filter.staffId) ||
    Boolean(filter.deviceId) ||
    Boolean(filter.method) ||
    Boolean(filter.status) ||
    (filter.query ?? '').trim() !== '';
  const visible = new Set(live.map((row) => String(row.sale.id)));
  const refunds = data.rangeRefunds
    .filter((r) => !filter.branchId || r.branch_id === filter.branchId)
    .filter((r) => !narrowed || visible.has(String(r.sale_id)))
    .reduce((sum, r) => sum + n(r.amount) + n(r.udhaar_part), 0);
  const bills = live.length;
  const sold = soldGross - refunds;
  return {
    rows,
    days,
    summary: {
      bills,
      sold,
      refunds,
      avgBill: bills > 0 ? mulDivRound(sold, 1, bills) : 0,
    },
  };
}

/** Sales list for one filter, newest first, grouped by business date (screens/10). */
export async function salesHistory(
  src: TableSource,
  filter: SalesFilter,
): Promise<SalesHistory> {
  const range = { from: filter.from, to: filter.to };
  const data = await loadSalesHistory(src, range);
  const lineText = (filter.query ?? '').trim()
    ? await loadSalesLineText(src, range)
    : undefined;
  return filterSalesHistory(data, filter, lineText);
}

export async function salesFilterOptions(
  src: TableSource,
): Promise<{ staff: SalesOption[]; devices: SalesOption[] }> {
  const staff = (await (src.table('staff') as Table<MasterRow>).toArray())
    .filter((s) => !s.deleted_at && s.active === 1)
    .map((s) => ({ id: s.id, name: String(s.name) }));
  const devices = (await (src.table('devices') as Table<SyncedRow>).toArray())
    .map((d) => ({ id: String(d.id), name: String(d.name ?? d.code ?? '') }))
    .filter((d) => d.name !== '' && d.name !== 'undefined');
  return { staff, devices };
}

const TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function timeText(at: number, timeZone: string): string {
  let formatter = TIME_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    TIME_FORMATTERS.set(timeZone, formatter);
  }
  return formatter.format(at);
}

/** CSV status names follow the till labels, while the stored lifecycle values stay `paid`/`void`. */
function csvStatus(status: string): string {
  if (status === 'paid') return 'completed';
  if (status === 'void') return 'cancelled';
  return status;
}

/**
 * CSV for the filtered list (screens/10 AC 4): one row per bill, amounts in rupees, exact header.
 */
export function salesCsv(
  rows: readonly SaleListRow[],
  timeZone: string,
): string {
  const header = [
    'invoice_no',
    'date',
    'time',
    'customer',
    'items',
    'subtotal',
    'discounts',
    'tax',
    'total',
    'cash',
    'card',
    'bank_wallet',
    'udhaar',
    'refunded',
    'status',
    'cashier',
    'device',
  ];
  return [header.join(',')]
    .concat(
      rows.map((row) => {
        const sale = row.sale;
        return [
          String(sale.invoice_no),
          String(sale.business_date),
          timeText(n(sale.created_at), timeZone),
          row.customerName ?? '',
          qtyCsv(n(sale.items_qty_milli)),
          rupeesCsv(n(sale.subtotal)),
          rupeesCsv(
            n(sale.item_discount_total) +
              n(sale.bill_discount) +
              n(sale.bundle_discount_total),
          ),
          rupeesCsv(n(sale.tax)),
          rupeesCsv(n(sale.total)),
          rupeesCsv(row.applied.cash),
          rupeesCsv(row.applied.card),
          rupeesCsv(row.applied.bank_wallet),
          rupeesCsv(n(sale.udhaar_amount)),
          rupeesCsv(row.refunded),
          csvStatus(String(sale.status)),
          row.staffName,
          row.deviceName,
        ]
          .map(csvCell)
          .join(',');
      }),
    )
    .join('\r\n');
}

export type BillLine = {
  line: SyncedRow;
  refundedMilli: number;
  keptMilli: number;
  unit: string;
  trackStock: boolean;
  /** Current product row when it still exists and is not deleted; null for quick sales/deleted products. */
  product: MasterRow | null;
  /** Current bundle row for a bundle component line; null otherwise. */
  bundleProduct: MasterRow | null;
  /** Cart line note (stored in `sale_lines.serial`); empty when none. */
  note: string;
};

export type BillRefund = {
  refund: SyncedRow;
  lines: SyncedRow[];
  staffName: string | null;
};

export type BillDetail = {
  sale: SyncedRow;
  lines: BillLine[];
  refunds: BillRefund[];
  payments: SyncedRow[];
  voidPayments: SyncedRow[];
  voidRow: SyncedRow | null;
  replacementInvoiceNo: string | null;
  replacementSaleId: string | null;
  replacedInvoiceNo: string | null;
  replacedSaleId: string | null;
  customer: MasterRow | null;
  staffName: string;
  deviceName: string;
  branchName: string;
  refundedTotal: number;
  audit: SyncedRow[];
  /** Sync conflicts that touch this bill (over_refund, refund_after_void). */
  conflicts: SyncedRow[];
  latestJob: PrintJobLite | undefined;
};

/** One bill with its lines, refunds, void and audit trail (screens/10 bill detail). */
export async function billDetail(
  src: TableSource,
  saleId: string,
): Promise<BillDetail | null> {
  const sales = src.table('sales') as Table<SyncedRow>;
  const sale = await sales.get(saleId);
  if (!sale) return null;
  const lines = await (src.table('sale_lines') as Table<SyncedRow>)
    .where('sale_id')
    .equals(saleId)
    .sortBy('line_no');
  const refunds = (
    await (src.table('refunds') as Table<SyncedRow>)
      .where('sale_id')
      .equals(saleId)
      .toArray()
  ).sort(
    (a, b) =>
      n(a.created_at) - n(b.created_at) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const refundLines = refunds.length
    ? await (src.table('refund_lines') as Table<SyncedRow>)
        .where('refund_id')
        .anyOf(refunds.map((r) => r.id))
        .toArray()
    : [];
  const products = new Map(
    (
      await (src.table('products') as Table<MasterRow>).bulkGet([
        ...new Set(
          lines
            .flatMap((line) => [line.product_id, line.bundle_id])
            .filter((id): id is string => typeof id === 'string' && id !== ''),
        ),
      ])
    )
      .filter((p): p is MasterRow => p !== undefined)
      .map((p) => [p.id, p]),
  );
  const refundedByLine = new Map<string, number>();
  for (const rl of refundLines) {
    const key = String(rl.sale_line_id);
    refundedByLine.set(key, (refundedByLine.get(key) ?? 0) + n(rl.qty_milli));
  }
  const payments = (
    await (src.table('payments') as Table<SyncedRow>)
      .where('sale_id')
      .equals(saleId)
      .toArray()
  ).sort(
    (a, b) =>
      n(a.created_at) - n(b.created_at) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const voidRow =
    (await (src.table('sale_voids') as Table<SyncedRow>)
      .where('sale_id')
      .equals(saleId)
      .first()) ?? null;

  const ids = [
    ...new Set(
      [
        sale.staff_id,
        voidRow?.staff_id,
        ...refunds.map((r) => r.staff_id),
      ].filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ];
  const staff = new Map(
    (await (src.table('staff') as Table<MasterRow>).bulkGet(ids))
      .filter((s): s is MasterRow => s !== undefined)
      .map((s) => [s.id, s]),
  );
  const seller = staff.get(String(sale.staff_id));
  const deviceName = sale.device_id
    ? await deviceNameOf(src, String(sale.device_id))
    : '';
  const branch = sale.branch_id
    ? await (src.table('branches') as Table<MasterRow>).get(
        String(sale.branch_id),
      )
    : undefined;
  const customer = sale.customer_id
    ? ((await (src.table('customers') as Table<MasterRow>).get(
        String(sale.customer_id),
      )) ?? null)
    : null;

  const replacementId = voidRow?.replacement_sale_id;
  const replacement = replacementId
    ? await sales.get(String(replacementId))
    : undefined;
  const replaced = sale.replaces_sale_id
    ? await sales.get(String(sale.replaces_sale_id))
    : undefined;

  // Conflicts store the conflicted document/line id in `row_id` (a refund, refund line
  // or void), never the sale id. Resolve them from the rows this bill already loaded with
  // the V18 `[tbl+row_id]` index; parsing every historical `fields_json` on bill open was
  // the cost this lookup removes.
  const conflictKeys: [string, string][] = [
    ['sales', saleId],
    ...refunds.map(
      (refund) => ['refunds', String(refund.id)] as [string, string],
    ),
    ...refundLines.map(
      (line) => ['refund_lines', String(line.id)] as [string, string],
    ),
    ...lines.map((line) => ['sale_lines', String(line.id)] as [string, string]),
  ];
  if (voidRow) conflictKeys.push(['sale_voids', String(voidRow.id)]);
  const conflicts = await (src.table('sync_conflicts') as Table<SyncedRow>)
    .where('[tbl+row_id]')
    .anyOf(conflictKeys)
    .toArray();
  const auditTable = src.table('audit_log') as Table<SyncedRow>;
  const auditKeys: [string, string][] = [
    ['sales', saleId],
    ...refunds.map((refund) => ['refunds', refund.id] as [string, string]),
  ];
  if (voidRow) auditKeys.push(['sale_voids', voidRow.id]);
  const audit = await auditTable
    .where('[entity+entity_id]')
    .anyOf(auditKeys)
    .toArray();

  const jobs = await (src.table('print_jobs') as Table<PrintJobLite>)
    .where('sale_id')
    .equals(saleId)
    .toArray();

  return {
    sale,
    lines: lines.map((line) => {
      const refundedMilli = refundedByLine.get(line.id) ?? 0;
      const product = line.product_id
        ? products.get(String(line.product_id))
        : undefined;
      const bundleProduct = line.bundle_id
        ? products.get(String(line.bundle_id))
        : undefined;
      return {
        line,
        refundedMilli,
        keptMilli: Math.max(0, n(line.qty_milli) - refundedMilli),
        unit: String(product?.unit ?? 'pc'),
        trackStock: product?.track_stock === 1,
        product: product && !product.deleted_at ? product : null,
        bundleProduct:
          bundleProduct && !bundleProduct.deleted_at ? bundleProduct : null,
        note: String(line.serial ?? '').trim(),
      };
    }),
    refunds: refunds.map((refund) => ({
      refund,
      lines: refundLines.filter((rl) => rl.refund_id === refund.id),
      staffName: refund.staff_id
        ? String(staff.get(String(refund.staff_id))?.name ?? '')
        : null,
    })),
    payments,
    voidPayments: payments.filter(
      (p) => p.direction === 'out' && p.purpose === 'void',
    ),
    voidRow,
    replacementInvoiceNo: replacement ? String(replacement.invoice_no) : null,
    replacementSaleId: replacement ? String(replacement.id) : null,
    replacedInvoiceNo: replaced ? String(replaced.invoice_no) : null,
    replacedSaleId: replaced ? String(replaced.id) : null,
    customer,
    staffName: seller ? String(seller.name) : '',
    deviceName,
    branchName: branch ? String(branch.name ?? '') : '',
    refundedTotal: refunds.reduce(
      (s, r) => s + n(r.amount) + n(r.udhaar_part),
      0,
    ),
    audit,
    conflicts,
    latestJob: latestSaleJob(jobs, saleId),
  };
}
