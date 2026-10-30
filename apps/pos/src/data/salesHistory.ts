import { businessDate } from '@bikri/core';
import type { MasterRow, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import { csvCell, qtyCsv, rupeesCsv } from '../lib/csv.ts';
import type { TableSource } from './caches.ts';

const n = (v: unknown): number => Number(v ?? 0);

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

export async function shopTimeZone(src: TableSource): Promise<string> {
  const shop = await (src.table('shop') as Table<MasterRow, string>).get(
    'shop',
  );
  const tz = String(shop?.timezone ?? 'Asia/Karachi');
  return tz === '' ? 'Asia/Karachi' : tz;
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
function failedPrint(
  jobs: readonly PrintJobLite[],
  saleId: string,
): { failed: boolean; jobId: string | null } {
  let failed = false;
  let jobId: string | null = null;
  for (const job of saleJobs(jobs, saleId)) {
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
async function matchingSaleIds(
  src: TableSource,
  sales: readonly SyncedRow[],
  query: string,
): Promise<Set<string> | null> {
  const q = query.trim().toLowerCase();
  if (q === '') return null;
  const words = q.split(/\s+/u).filter(Boolean);
  const inRange = new Set(sales.map((s) => s.id));
  const ids = new Set<string>();
  for (const sale of sales)
    if (String(sale.invoice_no).toLowerCase().includes(q)) ids.add(sale.id);

  const digits = q.replace(/\D/gu, '').replace(/^0+/u, '');
  const customerIds = new Set<string>();
  for (const c of await (
    src.table('customers') as Table<MasterRow>
  ).toArray()) {
    if (c.deleted_at) continue;
    const name = String(c.name ?? '').toLowerCase();
    const phone = String(c.phone ?? '').replace(/\D/gu, '');
    if (
      words.every((w) => name.includes(w)) ||
      (digits.length >= 3 && phone.includes(digits))
    )
      customerIds.add(c.id);
  }
  if (customerIds.size > 0)
    for (const sale of sales)
      if (sale.customer_id && customerIds.has(String(sale.customer_id)))
        ids.add(sale.id);

  const lines = (src.table('sale_lines') as Table<SyncedRow>).filter((l) => {
    const name = String(l.name_snapshot ?? '').toLowerCase();
    const sku = String(l.sku_snapshot ?? '').toLowerCase();
    return (
      words.every((w) => name.includes(w)) || (q.length >= 3 && sku.includes(q))
    );
  });
  for (const line of await lines.toArray())
    if (inRange.has(String(line.sale_id))) ids.add(String(line.sale_id));
  return ids;
}

/** Sales list for one filter, newest first, grouped by business date (screens/10). */
export async function salesHistory(
  src: TableSource,
  filter: SalesFilter,
): Promise<SalesHistory> {
  let sales = (
    await (src.table('sales') as Table<SyncedRow>)
      .where('business_date')
      .between(filter.from, filter.to, true, true)
      .toArray()
  )
    .filter((s) => !filter.branchId || s.branch_id === filter.branchId)
    .filter((s) => !filter.staffId || s.staff_id === filter.staffId)
    .filter((s) => !filter.deviceId || s.device_id === filter.deviceId)
    .filter((s) => !filter.status || s.status === filter.status);

  const matched = await matchingSaleIds(src, sales, filter.query ?? '');
  if (matched) sales = sales.filter((s) => matched.has(s.id));

  const ids = sales.map((s) => s.id);
  const paymentsById = new Map<string, SyncedRow[]>();
  if (ids.length > 0) {
    const pays = await (src.table('payments') as Table<SyncedRow>)
      .where('sale_id')
      .anyOf(ids)
      .toArray();
    for (const p of pays) {
      const key = String(p.sale_id);
      const list = paymentsById.get(key) ?? [];
      list.push(p);
      paymentsById.set(key, list);
    }
  }

  const refundsById = new Map<string, SyncedRow[]>();
  if (ids.length > 0) {
    const refunds = await (src.table('refunds') as Table<SyncedRow>)
      .where('sale_id')
      .anyOf(ids)
      .toArray();
    for (const r of refunds) {
      const key = String(r.sale_id);
      const list = refundsById.get(key) ?? [];
      list.push(r);
      refundsById.set(key, list);
    }
  }

  const jobs = (
    await (src.table('print_jobs') as Table<PrintJobLite>).toArray()
  ).filter((j) => j.sale_id !== undefined && ids.includes(j.sale_id));

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
  const deviceNames = new Map<string, string>();
  for (const id of new Set(sales.map((s) => String(s.device_id))))
    deviceNames.set(id, await deviceNameOf(src, id));

  const rows: SaleListRow[] = [];
  for (const sale of sales) {
    const pays = paymentsById.get(sale.id) ?? [];
    const methods = methodsOf(sale, pays);
    if (filter.method && !matchesMethod(methods, filter.method)) continue;
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
    const print = failedPrint(jobs, sale.id);
    rows.push({
      sale,
      customerName: customer ? String(customer.name) : null,
      customerPhone: customer?.phone ? String(customer.phone) : null,
      staffName: seller ? String(seller.name) : '',
      deviceName: deviceNames.get(String(sale.device_id)) ?? '',
      methods,
      applied,
      refunded,
      printFailed: print.failed,
      printJobId: print.jobId,
    });
  }

  rows.sort(
    (a, b) =>
      n(b.sale.created_at) - n(a.sale.created_at) ||
      n(b.sale.invoice_seq) - n(a.sale.invoice_seq) ||
      String(b.sale.id).localeCompare(String(a.sale.id)),
  );

  const days: SalesDay[] = [];
  for (const row of rows) {
    const date = String(row.sale.business_date);
    const last = days.at(-1);
    if (!last || last.date !== date) {
      days.push({ date, bills: 0, total: 0, rows: [row] });
      continue;
    }
    last.rows.push(row);
  }
  for (const day of days) {
    for (const row of day.rows) {
      if (row.sale.status === 'void') continue;
      day.bills += 1;
      day.total += n(row.sale.total);
    }
  }

  const live = rows.filter((r) => r.sale.status !== 'void');
  const soldGross = live.reduce((s, r) => s + n(r.sale.total), 0);
  // Match reports: refunds count on the date they happen, not the original sale date.
  const rangeRefunds = await (src.table('refunds') as Table<SyncedRow>)
    .where('business_date')
    .between(filter.from, filter.to, true, true)
    .toArray();
  const refunds = rangeRefunds
    .filter((r) => !filter.branchId || r.branch_id === filter.branchId)
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
      avgBill: bills > 0 ? Math.round(sold / bills) : 0,
    },
  };
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

function timeText(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
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
          rupeesCsv(n(sale.item_discount_total) + n(sale.bill_discount)),
          rupeesCsv(n(sale.tax)),
          rupeesCsv(n(sale.total)),
          rupeesCsv(row.applied.cash),
          rupeesCsv(row.applied.card),
          rupeesCsv(row.applied.bank_wallet),
          rupeesCsv(n(sale.udhaar_amount)),
          rupeesCsv(row.refunded),
          String(sale.status),
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
            .map((l) => l.product_id)
            .filter((id): id is string => typeof id === 'string'),
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

  const conflicts = (
    await (src.table('sync_conflicts') as Table<SyncedRow>).toArray()
  ).filter((row) => {
    try {
      const fields = JSON.parse(String(row.fields_json ?? '{}')) as {
        sale_id?: unknown;
      };
      return fields.sale_id === saleId;
    } catch {
      return false;
    }
  });
  const auditTable = src.table('audit_log') as Table<SyncedRow>;
  const audit = await auditTable
    .where('[entity+entity_id]')
    .equals(['sales', saleId])
    .toArray();
  for (const refund of refunds)
    audit.push(
      ...(await auditTable
        .where('[entity+entity_id]')
        .equals(['refunds', refund.id])
        .toArray()),
    );
  if (voidRow)
    audit.push(
      ...(await auditTable
        .where('[entity+entity_id]')
        .equals(['sale_voids', voidRow.id])
        .toArray()),
    );

  const jobs = (
    await (src.table('print_jobs') as Table<PrintJobLite>).toArray()
  ).filter((j) => j.sale_id === saleId);

  return {
    sale,
    lines: lines.map((line) => {
      const refundedMilli = refundedByLine.get(line.id) ?? 0;
      const product = line.product_id
        ? products.get(String(line.product_id))
        : undefined;
      return {
        line,
        refundedMilli,
        keptMilli: Math.max(0, n(line.qty_milli) - refundedMilli),
        unit: String(product?.unit ?? 'pc'),
        trackStock: product?.track_stock === 1,
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
