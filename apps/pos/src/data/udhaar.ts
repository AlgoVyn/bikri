import { businessDate, can, newId, type Role } from '@bikri/core';
import type {
  BikriDb,
  MasterRow,
  PartyBalance,
  PartyType,
  SyncedRow,
} from '@bikri/db';
import type { Table } from 'dexie';
import { csvCell, qtyCsv, rupeesCsv } from '../lib/csv.ts';
import { formatShopMoney } from '../lib/money';

const NAME_COLLATOR = new Intl.Collator();

import type { SortDirection } from '../lib/sort.ts';
import { isReadOnly } from '../sync/status.ts';
import { rowsAnyOfTable } from './bulk.ts';
import type { TableSource } from './caches.ts';
import { isBusinessDate } from './dates.ts';
import type { LedgerContext } from './products.ts';
import { waLink } from './receipt.ts';
import { type Writer, writeAction, writeScope } from './write.ts';

const DAY = 86_400_000;
const n = (v: unknown): number => Number(v ?? 0);
const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export type CustomerFilter =
  | 'all'
  | 'owes'
  | 'over_limit'
  | 'in_credit'
  | 'promise_due';
export type CustomerSort =
  | 'balance'
  | 'oldest'
  | 'name'
  | 'activity'
  | 'limit'
  | 'promise';

/** Natural first-click order for each Udhaar column. */
export const CUSTOMER_SORT_DIRECTIONS: Record<CustomerSort, SortDirection> = {
  balance: 'desc',
  oldest: 'asc',
  name: 'asc',
  activity: 'desc',
  limit: 'desc',
  promise: 'asc',
};

export function defaultCustomerSortDirection(
  sort: CustomerSort,
): SortDirection {
  return CUSTOMER_SORT_DIRECTIONS[sort];
}

export type CustomerRow = {
  customer: MasterRow;
  /** Lower-case name and digit-only phone, computed once when the directory loads. */
  searchName?: string;
  searchDigits?: string;
  balance: number;
  oldestUnpaidAt: number | null;
  lastActivityAt: number;
  /** Last customer/supplier payment, from the party-balance cache (V11). */
  lastPaymentAt: number | null;
  /** Earliest open promise, if any. */
  promise: SyncedRow | null;
};

export type CustomerList = {
  rows: CustomerRow[];
  totalOwed: number;
  owingCount: number;
  receivedThisMonth: number;
};

export type CustomerListOptions = {
  query?: string;
  filter?: CustomerFilter;
  sort?: CustomerSort;
  direction?: SortDirection;
  today: string;
  now?: number;
};

export type StatementKind =
  | 'sale'
  | 'payment'
  | 'refund'
  | 'void'
  | 'opening'
  | 'adjustment';

/** One sale line included in a detailed statement export. */
export type StatementItem = {
  name: string;
  qtyMilli: number;
  /** List/selling unit price in paisa. */
  unitPrice: number;
  /** Line net in paisa, before the bill-level discount/tax allocation. */
  amount: number;
};

/** One bill-detail line used by CSV, PDF/PNG and thermal printing. */
export function statementItemLabel(item: StatementItem): string {
  return `${item.name} × ${qtyCsv(item.qtyMilli)} · ${formatShopMoney(item.unitPrice)} each — ${formatShopMoney(item.amount)}`;
}

export type StatementEntry = {
  entry: SyncedRow;
  kind: StatementKind;
  invoiceNo: string | null;
  saleId: string | null;
  lineCount: number;
  method: string | null;
  note: string;
  debit: number;
  credit: number;
  balance: number;
  /** The bill this row belongs to was voided (the UI badges the bill row). */
  voided: boolean;
  /** Only filled for export rows; the on-screen statement stays compact. */
  items?: StatementItem[];
};

export type Statement = {
  rows: StatementEntry[];
  /** Balance before the first row of the chosen range. */
  openingBalance: number;
  /** Balance today (all entries, not only the range). */
  balance: number;
  lastPaymentAt: number | null;
  /** Older entries exist beyond the requested page. */
  hasMore: boolean;
};

export type StatementCsvRow = {
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  items?: readonly StatementItem[];
};

export class PaymentError extends Error {
  readonly code: 'amount' | 'date' | 'owner' | 'customer' | 'method';
  constructor(code: PaymentError['code']) {
    super(code);
    this.name = 'PaymentError';
    this.code = code;
  }
}

export class PromiseError extends Error {
  readonly code: 'date' | 'amount' | 'customer';
  constructor(code: PromiseError['code']) {
    super(code);
    this.name = 'PromiseError';
    this.code = code;
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function balancesOf(
  src: TableSource,
): Promise<Map<string, PartyBalance>> {
  const rows = await (src.table('party_balances') as Table<PartyBalance>)
    .where('[party_type+party_id]')
    .between(['customer', ''], ['customer', '\uffff'])
    .toArray();
  return new Map(rows.map((row) => [row.party_id, row]));
}

async function openPromises(
  src: TableSource,
): Promise<Map<string, SyncedRow[]>> {
  const rows = (
    await (src.table('promises') as Table<SyncedRow>)
      .where('[status+promised_on]')
      .between(['open', ''], ['open', '\uffff'], true, true)
      .toArray()
  ).filter((p) => !p.deleted_at);
  const map = new Map<string, SyncedRow[]>();
  for (const promise of rows) {
    const key = String(promise.customer_id);
    const list = map.get(key) ?? [];
    list.push(promise);
    map.set(key, list);
  }
  return map;
}

export type CustomerListData = {
  /** Every live customer with its cached balance and earliest open promise. */
  rows: CustomerRow[];
  /** Customer payments in the selected month (for the header card). */
  payments: SyncedRow[];
};

/** Loads the customer directory once; filtering/sorting stays in memory. */
export async function loadCustomerListData(
  src: TableSource,
  today: string,
): Promise<CustomerListData> {
  const balances = await balancesOf(src);
  const promises = await openPromises(src);
  const customers = (
    await (src.table('customers') as Table<MasterRow>).toArray()
  ).filter((c) => !c.deleted_at);
  const rows: CustomerRow[] = customers.map((customer) => {
    const balance = balances.get(customer.id);
    const promise = promises.get(customer.id)?.[0] ?? null;
    return {
      customer,
      searchName: String(customer.name ?? '').toLowerCase(),
      searchDigits: String(customer.phone ?? '').replace(/\D/gu, ''),
      balance: balance?.balance ?? 0,
      oldestUnpaidAt: balance?.oldest_unpaid_at ?? null,
      lastActivityAt: balance?.last_activity_at ?? 0,
      lastPaymentAt: balance?.last_payment_at ?? null,
      promise,
    };
  });
  const month = today.slice(0, 7);
  const payments = (
    await (src.table('payments') as Table<SyncedRow>)
      .where('business_date')
      .between(`${month}-01`, `${month}-31`, true, true)
      .toArray()
  ).filter(
    (p) =>
      p.direction === 'in' &&
      p.purpose === 'customer_payment' &&
      p.party_type === 'customer',
  );
  return { rows, payments };
}

/** Pure filter/sort for the loaded directory: a keystroke does not touch IndexedDB. */
export function filterCustomerList(
  data: CustomerListData,
  options: CustomerListOptions,
): CustomerList {
  const query = (options.query ?? '').trim().toLowerCase();
  const words = query.split(/\s+/u).filter(Boolean);
  const digits = query.replace(/\D/gu, '').replace(/^0+/u, '');
  const { rows, payments } = data;
  const matching = rows.filter((row) => {
    if (query === '') return true;
    const name =
      row.searchName ?? String(row.customer.name ?? '').toLowerCase();
    const phone =
      row.searchDigits ?? String(row.customer.phone ?? '').replace(/\D/gu, '');
    return (
      words.every((word) => name.includes(word)) ||
      (digits.length >= 3 && phone.includes(digits))
    );
  });

  const dueToday = (row: CustomerRow) =>
    row.promise !== null && String(row.promise.promised_on) <= options.today;
  const filter = options.filter ?? 'all';
  const filtered = matching.filter((row) => {
    if (filter === 'owes') return row.balance > 0;
    if (filter === 'in_credit') return row.balance < 0;
    if (filter === 'over_limit')
      return (
        row.customer.credit_limit !== null &&
        row.customer.credit_limit !== undefined &&
        row.balance > Number(row.customer.credit_limit)
      );
    if (filter === 'promise_due') return dueToday(row);
    return true;
  });

  const sort = options.sort ?? 'name';
  const sign =
    (options.direction ?? defaultCustomerSortDirection(sort)) === 'asc'
      ? 1
      : -1;
  const byName = (a: CustomerRow, b: CustomerRow) =>
    NAME_COLLATOR.compare(String(a.customer.name), String(b.customer.name));
  filtered.sort((a, b) => {
    let value = 0;
    if (sort === 'balance') value = a.balance - b.balance;
    else if (sort === 'oldest') {
      if (a.oldestUnpaidAt === null || b.oldestUnpaidAt === null) {
        if (a.oldestUnpaidAt === null && b.oldestUnpaidAt === null)
          return byName(a, b);
        return a.oldestUnpaidAt === null ? 1 : -1;
      }
      value = a.oldestUnpaidAt - b.oldestUnpaidAt;
    } else if (sort === 'activity') value = a.lastActivityAt - b.lastActivityAt;
    else if (sort === 'limit') {
      const aLimit =
        a.customer.credit_limit === null ||
        a.customer.credit_limit === undefined
          ? null
          : Number(a.customer.credit_limit);
      const bLimit =
        b.customer.credit_limit === null ||
        b.customer.credit_limit === undefined
          ? null
          : Number(b.customer.credit_limit);
      if (aLimit === null || bLimit === null) {
        if (aLimit === null && bLimit === null) return byName(a, b);
        return aLimit === null ? 1 : -1;
      }
      value = aLimit - bLimit;
    } else if (sort === 'promise') {
      const aDate = a.promise ? String(a.promise.promised_on) : null;
      const bDate = b.promise ? String(b.promise.promised_on) : null;
      if (aDate === null || bDate === null) {
        if (aDate === null && bDate === null) return byName(a, b);
        return aDate === null ? 1 : -1;
      }
      value = aDate.localeCompare(bDate);
    } else value = byName(a, b);
    return value === 0 ? byName(a, b) : sign * value;
  });

  return {
    rows: filtered,
    totalOwed: rows.reduce((sum, row) => sum + Math.max(0, row.balance), 0),
    owingCount: rows.filter((row) => row.balance > 0).length,
    receivedThisMonth: payments.reduce((sum, p) => sum + n(p.amount), 0),
  };
}

/** Convenience wrapper for callers that do not already hold the directory. */
export async function customerList(
  src: TableSource,
  options: CustomerListOptions,
): Promise<CustomerList> {
  return filterCustomerList(
    await loadCustomerListData(src, options.today),
    options,
  );
}

/** One row per customer for the list CSV. */
export function customersCsv(
  rows: readonly CustomerRow[],
  timeZone: string,
  now = Date.now(),
): string {
  const header = [
    'name',
    'phone',
    'balance',
    'oldest_unpaid_days',
    'credit_limit',
    'promise_on',
    'last_activity',
  ];
  const day = (at: number | null): string =>
    at === null ? '' : String(Math.max(0, Math.floor((now - at) / DAY)));
  const date = (at: number | null): string => {
    if (at === null) return '';
    let formatter = DATE_FORMATTERS.get(timeZone);
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      DATE_FORMATTERS.set(timeZone, formatter);
    }
    return formatter.format(at);
  };
  return [header.join(',')]
    .concat(
      rows.map((row) =>
        [
          String(row.customer.name),
          String(row.customer.phone ?? ''),
          rupeesCsv(row.balance),
          day(row.oldestUnpaidAt),
          row.customer.credit_limit === null ||
          row.customer.credit_limit === undefined
            ? ''
            : rupeesCsv(Number(row.customer.credit_limit)),
          row.promise ? String(row.promise.promised_on) : '',
          date(row.lastActivityAt || null),
        ]
          .map(csvCell)
          .join(','),
      ),
    )
    .join('\r\n');
}

/** Khata entries oldest first, with the running balance (screens/12 statement). */
export async function customerStatement(
  src: TableSource,
  customerId: string,
  range?: { from: string; to: string },
  limit = Number.POSITIVE_INFINITY,
  withItems = false,
  includeVoids = true,
): Promise<Statement> {
  const from = range?.from ?? '0000-01-01';
  const to = range?.to ?? '9999-12-31';
  const base = (src.table('ledger_entries') as Table<SyncedRow>).where(
    '[party_type+party_id+business_date+created_at]',
  );
  const bounds = [
    ['customer', customerId, from, 0],
    ['customer', customerId, to, Number.MAX_SAFE_INTEGER],
  ] as const;
  // The UI shows a voided bill with its reversing row and a Cancelled badge; the
  // export leaves both out because the pair only adds noise. Look up `sale_voids`
  // only for the sale rows this statement actually loads, never the whole table.
  const voidedSaleIdsFor = async (
    rows: readonly SyncedRow[],
  ): Promise<Set<string>> => {
    const saleIds = [
      ...new Set(
        rows
          .filter((entry) => entry.source_type === 'sale' && entry.source_id)
          .map((entry) => String(entry.source_id)),
      ),
    ];
    if (saleIds.length === 0) return new Set();
    const voidRows = await rowsAnyOfTable<SyncedRow>(
      src.table('sale_voids') as Table<SyncedRow>,
      'sale_id',
      saleIds,
      (row) => String(row.sale_id),
      // Never fall back to a whole-table scan: the point of this lookup is to
      // stay scoped to the rows the statement already loaded.
      Number.POSITIVE_INFINITY,
    );
    return new Set(voidRows.map((row) => String(row.sale_id)));
  };
  const voidRelated = (
    entry: SyncedRow,
    voidedIds: ReadonlySet<string>,
  ): boolean =>
    entry.source_type === 'void' ||
    (entry.source_type === 'sale' &&
      entry.source_id !== null &&
      entry.source_id !== undefined &&
      voidedIds.has(String(entry.source_id)));
  const visible = (
    rows: readonly SyncedRow[],
    voidedIds: ReadonlySet<string>,
  ): SyncedRow[] =>
    includeVoids
      ? [...rows]
      : rows.filter((entry) => !voidRelated(entry, voidedIds));
  const paged = range === undefined && Number.isFinite(limit);
  const take = Math.max(1, Math.floor(limit)) + 1;
  let page: SyncedRow[] = [];
  let pageVoidedSaleIds = new Set<string>();
  if (!paged) {
    const raw = await base.between(bounds[0], bounds[1]).toArray();
    pageVoidedSaleIds = await voidedSaleIdsFor(raw);
    page = visible(raw, pageVoidedSaleIds);
  } else if (includeVoids) {
    const raw = await base
      .between(bounds[0], bounds[1])
      .reverse()
      .limit(take)
      .toArray();
    pageVoidedSaleIds = await voidedSaleIdsFor(raw);
    page = raw;
  } else {
    // The export path is normally unbounded, but keep a finite page correct:
    // widen the raw window until enough non-voided rows are visible or the
    // collection is exhausted.
    let window = take;
    for (;;) {
      const raw = await base
        .between(bounds[0], bounds[1])
        .reverse()
        .limit(window)
        .toArray();
      const voidedIds = await voidedSaleIdsFor(raw);
      const shown = raw.filter((entry) => !voidRelated(entry, voidedIds));
      if (shown.length >= take || raw.length < window) {
        page = shown.slice(0, take);
        pageVoidedSaleIds = voidedIds;
        break;
      }
      window *= 2;
    }
  }
  const hasMore = paged && page.length > limit;
  const entries = (hasMore ? page.slice(0, limit) : page)
    .reverse()
    .sort(
      (a, b) =>
        String(a.business_date).localeCompare(String(b.business_date)) ||
        n(a.created_at) - n(b.created_at) ||
        String(a.id).localeCompare(String(b.id)),
    );
  const cachedBalance = (
    await (src.table('party_balances') as Table<PartyBalance>).get([
      'customer',
      customerId,
    ])
  )?.balance;
  const allEntries = async (): Promise<SyncedRow[]> => {
    const raw = await base
      .between(
        ['customer', customerId, '0000-01-01', 0],
        ['customer', customerId, '9999-12-31', Number.MAX_SAFE_INTEGER],
      )
      .toArray();
    return visible(raw, await voidedSaleIdsFor(raw));
  };
  const balance =
    cachedBalance ??
    (hasMore || range !== undefined
      ? (await allEntries()).reduce((sum, entry) => sum + n(entry.amount), 0)
      : entries.reduce((sum, entry) => sum + n(entry.amount), 0));

  const sourceIds = (type: string) =>
    entries
      .filter((e) => e.source_type === type && e.source_id)
      .map((e) => String(e.source_id));
  const sales = new Map(
    (await (src.table('sales') as Table<SyncedRow>).bulkGet(sourceIds('sale')))
      .filter((row): row is SyncedRow => row !== undefined)
      .map((row) => [row.id, row]),
  );
  const payments = new Map(
    (
      await (src.table('payments') as Table<SyncedRow>).bulkGet(
        sourceIds('payment'),
      )
    )
      .filter((row): row is SyncedRow => row !== undefined)
      .map((row) => [row.id, row]),
  );
  const refunds = new Map(
    (
      await (src.table('refunds') as Table<SyncedRow>).bulkGet(
        sourceIds('refund'),
      )
    )
      .filter((row): row is SyncedRow => row !== undefined)
      .map((row) => [row.id, row]),
  );
  const voids = new Map(
    (
      await (src.table('sale_voids') as Table<SyncedRow>).bulkGet(
        sourceIds('void'),
      )
    )
      .filter((row): row is SyncedRow => row !== undefined)
      .map((row) => [row.id, row]),
  );

  const saleOf = async (id: string): Promise<SyncedRow | undefined> => {
    if (sales.has(id)) return sales.get(id);
    const row = await (src.table('sales') as Table<SyncedRow>).get(id);
    if (row) sales.set(id, row);
    return row;
  };

  let openingBalance: number;
  let balances: number[];
  if (range !== undefined) {
    // A historical range needs the balance before its first row. Reading the
    // entries before `from` is bounded by the range the user chose.
    const before = await base
      .between(
        ['customer', customerId, '0000-01-01', 0],
        ['customer', customerId, range.from, -1],
      )
      .toArray();
    openingBalance = visible(before, await voidedSaleIdsFor(before)).reduce(
      (sum, entry) => sum + n(entry.amount),
      0,
    );
    let running = openingBalance;
    balances = entries.map((entry) => {
      running += n(entry.amount);
      return running;
    });
  } else {
    balances = new Array<number>(entries.length);
    let running = balance;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      balances[index] = running;
      running -= n(entries[index]?.amount);
    }
    openingBalance = running;
  }
  const all: StatementEntry[] = [];
  let lastPaymentAt: number | null = null;
  for (const [index, entry] of entries.entries()) {
    const amount = n(entry.amount);
    const sourceId = entry.source_id ? String(entry.source_id) : '';
    let kind: StatementKind = 'adjustment';
    let invoiceNo: string | null = null;
    let saleId: string | null = null;
    let lineCount = 0;
    let method: string | null = null;
    let voided = false;
    if (entry.source_type === 'sale') {
      const sale = sourceId ? await saleOf(sourceId) : undefined;
      kind = 'sale';
      invoiceNo = sale ? String(sale.invoice_no) : null;
      saleId = sale ? String(sale.id) : null;
      lineCount = sale ? n(sale.line_count) : 0;
      voided =
        pageVoidedSaleIds.has(sourceId) ||
        String(sale?.status ?? '') === 'void';
    } else if (entry.source_type === 'payment') {
      kind = 'payment';
      method = payments.get(sourceId)
        ? String(payments.get(sourceId)?.method)
        : null;
      lastPaymentAt = Math.max(lastPaymentAt ?? 0, n(entry.created_at));
    } else if (entry.source_type === 'refund') {
      kind = 'refund';
      const refund = refunds.get(sourceId);
      const sale = refund?.sale_id
        ? await saleOf(String(refund.sale_id))
        : undefined;
      invoiceNo = sale ? String(sale.invoice_no) : null;
      saleId = sale ? String(sale.id) : null;
    } else if (entry.source_type === 'void') {
      kind = 'void';
      const voidRow = voids.get(sourceId);
      const sale = voidRow?.sale_id
        ? await saleOf(String(voidRow.sale_id))
        : undefined;
      invoiceNo = sale ? String(sale.invoice_no) : null;
      saleId = sale ? String(sale.id) : null;
    } else if (entry.source_type === 'opening') {
      kind = 'opening';
    } else {
      kind = 'adjustment';
    }
    all.push({
      entry,
      kind,
      invoiceNo,
      saleId,
      lineCount,
      method,
      note: String(entry.note ?? ''),
      debit: Math.max(0, amount),
      credit: Math.max(0, -amount),
      balance: balances[index] ?? 0,
      voided,
    });
  }

  if (withItems) {
    const saleIds = [
      ...new Set(
        all
          .filter((row) => row.kind === 'sale' && row.saleId !== null)
          .map((row) => String(row.saleId)),
      ),
    ];
    const lines = await rowsAnyOfTable<SyncedRow>(
      src.table('sale_lines') as Table<SyncedRow>,
      'sale_id',
      saleIds,
      (row) => String(row.sale_id),
      // The page already bounds these ids; a table scan would read every line.
      Number.POSITIVE_INFINITY,
    );
    const bySale = new Map<string, { lineNo: number; item: StatementItem }[]>();
    for (const line of lines) {
      const saleId = String(line.sale_id);
      const group = bySale.get(saleId) ?? [];
      group.push({
        lineNo: n(line.line_no),
        item: {
          name: String(line.name_snapshot),
          qtyMilli: n(line.qty_milli),
          unitPrice: n(line.unit_price),
          amount: n(line.net),
        },
      });
      bySale.set(saleId, group);
    }
    for (const row of all) {
      if (row.kind !== 'sale' || row.saleId === null) continue;
      row.items = (bySale.get(row.saleId) ?? [])
        .sort((a, b) => a.lineNo - b.lineNo)
        .map((entry) => entry.item);
    }
  }

  return {
    rows: all,
    openingBalance,
    balance,
    lastPaymentAt,
    hasMore,
  };
}

/** CSV of the statement rows the caller formatted for the active language. */
export function statementCsv(rows: readonly StatementCsvRow[]): string {
  const header = ['date', 'description', 'debit', 'credit', 'balance'];
  const lines = rows.flatMap((row) => {
    const main = [
      row.date,
      row.description,
      rupeesCsv(row.debit),
      rupeesCsv(row.credit),
      rupeesCsv(row.balance),
    ];
    const items = (row.items ?? []).map((item) => [
      '',
      `  ${statementItemLabel(item)}`,
      '',
      '',
      '',
    ]);
    return [main, ...items];
  });
  return [header.join(',')]
    .concat(lines.map((line) => line.map(csvCell).join(',')))
    .join('\r\n');
}

export type ReceivePaymentInput = {
  paymentId: string;
  customerId: string;
  amount: number;
  method: 'cash' | 'card' | 'bank_wallet';
  reference?: string;
  provider?: string;
  date: string;
  note?: string;
};

export type ReceivePaymentOptions = {
  role: Role;
  today: string;
  now?: number;
};

/** Customer payment recipe (02 §5): payment + ledger row + open promises refreshed. */
export async function receivePayment(
  db: BikriDb,
  input: ReceivePaymentInput,
  ctx: LedgerContext,
  options: ReceivePaymentOptions,
): Promise<SyncedRow> {
  const existing = await db.payments.get(input.paymentId);
  if (existing) return existing;
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
    throw new PaymentError('amount');
  if (!['cash', 'card', 'bank_wallet'].includes(input.method))
    throw new PaymentError('method');
  if (
    !isBusinessDate(input.date) ||
    input.date > options.today ||
    input.date < addDays(options.today, -7)
  )
    throw new PaymentError('date');
  if (options.role !== 'owner' && input.date !== options.today)
    throw new PaymentError('owner');
  const customer = await db.customers.get(input.customerId);
  if (!customer || customer.deleted_at) throw new PaymentError('customer');
  const now = options.now ?? Date.now();
  return writeAction(
    db,
    async (w) => {
      const duplicate = (await w.table('payments').get(input.paymentId)) as
        | SyncedRow
        | undefined;
      if (duplicate) return duplicate;
      const payment: SyncedRow = {
        id: input.paymentId,
        direction: 'in',
        method: input.method,
        purpose: 'customer_payment',
        amount: input.amount,
        cash_tendered: null,
        change_given: null,
        reference: (input.reference ?? '').slice(0, 40),
        sale_id: null,
        refund_id: null,
        purchase_id: null,
        supplier_return_id: null,
        party_type: 'customer',
        party_id: input.customerId,
        note: [input.provider, input.note]
          .filter(Boolean)
          .join(' ')
          .slice(0, 120),
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: input.date,
        created_at: now,
      };
      await w.insert('payments', payment);
      await w.insert('ledger_entries', {
        id: newId(now),
        party_type: 'customer',
        party_id: input.customerId,
        amount: -input.amount,
        source_type: 'payment',
        source_id: input.paymentId,
        note: String(customer.name),
        branch_id: ctx.branch_id,
        device_id: ctx.device_id,
        staff_id: ctx.staff_id,
        business_date: input.date,
        created_at: now,
      });
      // `promises` upserts need `party.edit`; a cashier with only `payment.receive`
      // must still be able to take the money (SYNC-H5). Read the acting staff row, not
      // the caller's role, so the decision matches what the Worker will check.
      const actorRow = (await w.table('staff').get(ctx.staff_id)) as
        | SyncedRow
        | undefined;
      const canEditParty =
        actorRow !== undefined &&
        actorRow.active === 1 &&
        !actorRow.deleted_at &&
        can(
          actorRow.role as Role,
          String(actorRow.permissions_json ?? '{}'),
          'party.edit',
        );
      if (canEditParty) await keepPromises(w, input.customerId);
      return payment;
    },
    {
      now,
      actor: ctx.staff_id,
      tables: writeScope(
        'payments',
        'ledger_entries',
        'party_balances',
        'promises',
        'staff',
      ),
    },
  );
}

/** Marks open promises kept when this payment covered them (07 §5, screens/12). */
async function keepPromises(w: Writer, customerId: string): Promise<void> {
  const promises = (
    await (w.table('promises') as Table<SyncedRow>)
      .where('customer_id')
      .equals(customerId)
      .toArray()
  ).filter((p) => !p.deleted_at && p.status === 'open');
  if (promises.length === 0) return;
  const entries = await (w.table('ledger_entries') as Table<SyncedRow>)
    .where('[party_type+party_id+created_at]')
    .between(
      ['customer', customerId, -Infinity],
      ['customer', customerId, Infinity],
    )
    .toArray();
  const balance = entries.reduce((sum, e) => sum + n(e.amount), 0);
  for (const promise of promises) {
    const since = entries
      .filter(
        (e) =>
          e.source_type === 'payment' &&
          n(e.created_at) >= n(promise.created_at),
      )
      .reduce((sum, e) => sum - n(e.amount), 0);
    const amount = promise.amount === null ? null : Number(promise.amount ?? 0);
    if (balance <= 0 || (amount !== null && since >= amount))
      await w.update('promises', promise.id, { status: 'kept' });
  }
}

export type PromiseInput = {
  customerId: string;
  promisedOn: string;
  amount: number | null;
  note?: string;
};

/** Adds a promise (screens/12); amount null means the whole balance. */
export async function createPromise(
  db: BikriDb,
  input: PromiseInput,
  actor: string | null,
  options: { today: string; now?: number } = {
    today: businessDate(Date.now()),
  },
): Promise<MasterRow> {
  if (!isBusinessDate(input.promisedOn) || input.promisedOn < options.today)
    throw new PromiseError('date');
  if (
    input.amount !== null &&
    (!Number.isSafeInteger(input.amount) || input.amount <= 0)
  )
    throw new PromiseError('amount');
  const customer = await db.customers.get(input.customerId);
  if (!customer || customer.deleted_at) throw new PromiseError('customer');
  const now = options.now ?? Date.now();
  return writeAction(
    db,
    (w) =>
      w.create('promises', {
        customer_id: input.customerId,
        promised_on: input.promisedOn,
        amount: input.amount,
        status: 'open',
        note: (input.note ?? '').trim().slice(0, 120),
      }),
    { now, actor, tables: writeScope('promises') },
  );
}

/**
 * Recomputes open promises once a day (screens/12): kept when payments since the promise
 * cover it or the balance is cleared; broken the day after the promised date.
 */
export async function refreshPromises(
  db: BikriDb,
  options: { today: string; now?: number; actor: string | null },
): Promise<number> {
  // Status refresh is a server-auditable promise edit; without an actor the push is rejected.
  if (!options.actor) return 0;
  const actor = await db.staff.get(options.actor);
  if (
    !actor ||
    !can(
      actor.role as Role,
      String(actor.permissions_json ?? '{}'),
      'party.edit',
    )
  )
    return 0;
  // Opening the chase list must never write in a read-only shop or on a support device.
  if (await isReadOnly(db)) return 0;
  if ((await db.kv.get('device_kind'))?.value === 'support') return 0;
  // The docstring says once a day, but every Udhaar screen used to run it on mount.
  // Gate on the business date before reading promises or payments.
  const gate = (await db.kv.get('promises_refreshed_on'))?.value;
  if (gate === options.today) return 0;
  const promises = (
    await db.promises
      .where('[status+promised_on]')
      .between(['open', ''], ['open', '\uffff'])
      .toArray()
  ).filter((p) => !p.deleted_at);
  const markDone = () =>
    db.kv.put({ key: 'promises_refreshed_on', value: options.today });
  if (promises.length === 0) {
    await markDone();
    return 0;
  }
  const now = options.now ?? Date.now();
  const updates: { id: string; status: 'kept' | 'broken' }[] = [];
  const byCustomer = new Map<string, typeof promises>();
  for (const promise of promises) {
    const key = String(promise.customer_id);
    const list = byCustomer.get(key) ?? [];
    list.push(promise);
    byCustomer.set(key, list);
  }
  // One payments range scan, not one ledger query per customer. A customer payment is
  // an `in` payment with purpose `customer_payment`; its `created_at` is the moment the
  // promise can count it. Payments are much smaller than the full ledger.
  const earliest = Math.min(
    ...promises.map((promise) => n(promise.created_at) || 0),
  );
  const payments = await db.payments
    .where('created_at')
    .aboveOrEqual(earliest)
    .toArray();
  const paymentsByCustomer = new Map<
    string,
    { at: number; amount: number }[]
  >();
  for (const payment of payments) {
    if (
      payment.direction !== 'in' ||
      payment.purpose !== 'customer_payment' ||
      payment.party_type !== 'customer' ||
      typeof payment.party_id !== 'string'
    )
      continue;
    const key = String(payment.party_id);
    const list = paymentsByCustomer.get(key) ?? [];
    list.push({ at: n(payment.created_at), amount: n(payment.amount) });
    paymentsByCustomer.set(key, list);
  }
  const balanceRows = await db.party_balances.bulkGet(
    [...byCustomer.keys()].map((id) => ['customer', id] as [PartyType, string]),
  );
  const balanceById = new Map(
    [...byCustomer.keys()].map((id, index) => [
      id,
      balanceRows[index]?.balance ?? 0,
    ]),
  );
  for (const [customerId, customerPromises] of byCustomer) {
    const customerPayments = paymentsByCustomer.get(customerId) ?? [];
    const balance = balanceById.get(customerId) ?? 0;
    for (const promise of customerPromises) {
      const since = n(promise.created_at);
      const paid = customerPayments
        .filter((payment) => payment.at >= since)
        .reduce((sum, payment) => sum + payment.amount, 0);
      const amount =
        promise.amount === null ? null : Number(promise.amount ?? 0);
      if (balance <= 0 || (amount !== null && paid >= amount))
        updates.push({ id: promise.id, status: 'kept' });
      else if (options.today > String(promise.promised_on))
        updates.push({ id: promise.id, status: 'broken' });
    }
  }
  if (updates.length === 0) {
    await markDone();
    return 0;
  }
  // Keep every action under the 200-op limit even when a large shop has many
  // promises going due at once.
  for (let start = 0; start < updates.length; start += 100) {
    const chunk = updates.slice(start, start + 100);
    await writeAction(
      db,
      async (w) => {
        for (const update of chunk)
          await w.update('promises', update.id, { status: update.status });
      },
      {
        now,
        actor: options.actor,
        tables: ['outbox', 'pull_shadow', 'kv', 'promises'],
      },
    );
  }
  await markDone();
  return updates.length;
}

export type ChaseGroupKey = 'promise' | '0-7' | '8-30' | '31-60' | '60+';
export type ChaseRow = {
  customer: CustomerRow;
  ageDays: number;
  lastPaymentAt: number | null;
  group: ChaseGroupKey;
};
export type ChaseList = {
  groups: { key: ChaseGroupKey; rows: ChaseRow[]; total: number }[];
  total: number;
};

/** Chase list groups by oldest-unpaid age, with promises due at the top (screens/12). */
export async function chaseList(
  src: TableSource,
  options: { today: string; now?: number },
): Promise<ChaseList> {
  const list = await customerList(src, {
    filter: 'all',
    sort: 'oldest',
    today: options.today,
  });
  const owing = list.rows.filter((row) => row.balance > 0);
  const now = options.now ?? Date.now();
  const groups: ChaseList['groups'] = [
    { key: 'promise', rows: [], total: 0 },
    { key: '0-7', rows: [], total: 0 },
    { key: '8-30', rows: [], total: 0 },
    { key: '31-60', rows: [], total: 0 },
    { key: '60+', rows: [], total: 0 },
  ];
  for (const customer of owing) {
    const ageDays =
      customer.oldestUnpaidAt === null
        ? 0
        : Math.max(0, Math.floor((now - customer.oldestUnpaidAt) / DAY));
    const promiseDue =
      customer.promise !== null &&
      String(customer.promise.promised_on) <= options.today;
    const key: ChaseGroupKey = promiseDue
      ? 'promise'
      : ageDays <= 7
        ? '0-7'
        : ageDays <= 30
          ? '8-30'
          : ageDays <= 60
            ? '31-60'
            : '60+';
    const group = groups.find((g) => g.key === key) as (typeof groups)[number];
    group.rows.push({
      customer,
      ageDays,
      lastPaymentAt: customer.lastPaymentAt,
      group: key,
    });
    group.total += customer.balance;
  }
  return {
    groups: groups.filter((g) => g.rows.length > 0),
    total: owing.reduce((sum, row) => sum + row.balance, 0),
  };
}

export function chaseCsv(
  list: ChaseList,
  groupLabel: (key: ChaseGroupKey) => string,
  timeZone = 'Asia/Karachi',
): string {
  const header = [
    'group',
    'name',
    'phone',
    'balance',
    'age_days',
    'last_payment',
  ];
  return [header.join(',')]
    .concat(
      list.groups.flatMap((group) =>
        group.rows.map((row) =>
          [
            groupLabel(group.key),
            String(row.customer.customer.name),
            String(row.customer.customer.phone ?? ''),
            rupeesCsv(row.customer.balance),
            row.ageDays,
            row.lastPaymentAt === null
              ? ''
              : businessDate(row.lastPaymentAt, timeZone),
          ]
            .map(csvCell)
            .join(','),
        ),
      ),
    )
    .join('\r\n');
}

export type ReminderLanguage = 'en' | 'ur' | 'roman-ur';

/** Reminder text (REQ-B04); {balance} is passed already grouped but without "Rs". */
export function reminderMessage(
  language: ReminderLanguage,
  input: {
    name: string;
    shop: string;
    balance: number;
    date: string;
  },
): string {
  const amount = formatShopMoney(input.balance).replace(/^Rs /u, '');
  if (language === 'ur')
    return `السلام علیکم ${input.name}، ${input.shop} پر آپ کا بقایا ${amount} روپے ہے (${input.date})۔ مہربانی کر کے جلد ادا کر دیں۔ شکریہ!`;
  if (language === 'roman-ur')
    return `Assalam-o-Alaikum ${input.name}, ${input.shop} par aap ka baqaya Rs ${amount} hai (${input.date}). Meharbani kar ke jald ada kar dein. Shukriya!`;
  return `Assalam-o-Alaikum ${input.name}, your balance at ${input.shop} is Rs ${amount} (as of ${input.date}). Please clear it at your convenience. Thank you!`;
}

/** WhatsApp reminder URL, or null without a valid phone (screens/12 AC 3). */
export function reminderLink(phone: string, message: string): string | null {
  return waLink(phone, message);
}
