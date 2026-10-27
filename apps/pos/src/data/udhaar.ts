import { businessDate, formatMoney, newId, type Role } from '@bikri/core';
import type { BikriDb, MasterRow, PartyBalance, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import { csvCell, rupeesCsv } from '../lib/csv.ts';
import type { TableSource } from './caches.ts';
import type { LedgerContext } from './products.ts';
import { waLink } from './receipt.ts';
import { writeAction } from './write.ts';

const DAY = 86_400_000;
const n = (v: unknown): number => Number(v ?? 0);

export type CustomerFilter =
  | 'all'
  | 'owes'
  | 'over_limit'
  | 'in_credit'
  | 'promise_due';
export type CustomerSort = 'balance' | 'oldest' | 'name' | 'activity';

export type CustomerRow = {
  customer: MasterRow;
  balance: number;
  oldestUnpaidAt: number | null;
  lastActivityAt: number;
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
};

export type Statement = {
  rows: StatementEntry[];
  /** Balance before the first row of the chosen range. */
  openingBalance: number;
  /** Balance today (all entries, not only the range). */
  balance: number;
  lastPaymentAt: number | null;
};

export type StatementCsvRow = {
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
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
  const rows = (await (src.table('promises') as Table<SyncedRow>).toArray())
    .filter((p) => !p.deleted_at && p.status === 'open')
    .sort((a, b) => String(a.promised_on).localeCompare(String(b.promised_on)));
  const map = new Map<string, SyncedRow[]>();
  for (const promise of rows) {
    const key = String(promise.customer_id);
    const list = map.get(key) ?? [];
    list.push(promise);
    map.set(key, list);
  }
  return map;
}

/** Customers with balances, filters and the header cards (screens/12). */
export async function customerList(
  src: TableSource,
  options: CustomerListOptions,
): Promise<CustomerList> {
  const query = (options.query ?? '').trim().toLowerCase();
  const words = query.split(/\s+/u).filter(Boolean);
  const digits = query.replace(/\D/gu, '').replace(/^0+/u, '');
  const balances = await balancesOf(src);
  const promises = await openPromises(src);
  const customers = (
    await (src.table('customers') as Table<MasterRow>).toArray()
  ).filter((c) => !c.deleted_at);

  const rows: CustomerRow[] = [];
  for (const customer of customers) {
    const name = String(customer.name ?? '').toLowerCase();
    const phone = String(customer.phone ?? '').replace(/\D/gu, '');
    if (
      query !== '' &&
      !(
        words.every((word) => name.includes(word)) ||
        (digits.length >= 3 && phone.includes(digits))
      )
    )
      continue;
    const balance = balances.get(customer.id);
    const promise = promises.get(customer.id)?.[0] ?? null;
    rows.push({
      customer,
      balance: balance?.balance ?? 0,
      oldestUnpaidAt: balance?.oldest_unpaid_at ?? null,
      lastActivityAt: balance?.last_activity_at ?? 0,
      promise,
    });
  }

  const dueToday = (row: CustomerRow) =>
    row.promise !== null && String(row.promise.promised_on) <= options.today;
  const filter = options.filter ?? 'all';
  const filtered = rows.filter((row) => {
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
  filtered.sort((a, b) => {
    if (sort === 'balance') return b.balance - a.balance;
    if (sort === 'oldest')
      return (
        (a.oldestUnpaidAt ?? Number.POSITIVE_INFINITY) -
          (b.oldestUnpaidAt ?? Number.POSITIVE_INFINITY) ||
        String(a.customer.name).localeCompare(String(b.customer.name))
      );
    if (sort === 'activity') return b.lastActivityAt - a.lastActivityAt;
    return String(a.customer.name).localeCompare(String(b.customer.name));
  });

  const month = options.today.slice(0, 7);
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

  return {
    rows: filtered,
    totalOwed: rows.reduce((sum, row) => sum + Math.max(0, row.balance), 0),
    owingCount: rows.filter((row) => row.balance > 0).length,
    receivedThisMonth: payments.reduce((sum, p) => sum + n(p.amount), 0),
  };
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
  const date = (at: number | null): string =>
    at === null
      ? ''
      : new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(at);
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
): Promise<Statement> {
  const entries = (
    await (src.table('ledger_entries') as Table<SyncedRow>)
      .where('[party_type+party_id+created_at]')
      .between(
        ['customer', customerId, -Infinity],
        ['customer', customerId, Infinity],
      )
      .toArray()
  ).sort(
    (a, b) =>
      n(a.created_at) - n(b.created_at) ||
      String(a.id).localeCompare(String(b.id)),
  );

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

  const all: StatementEntry[] = [];
  let running = 0;
  let lastPaymentAt: number | null = null;
  for (const entry of entries) {
    const amount = n(entry.amount);
    running += amount;
    const sourceId = entry.source_id ? String(entry.source_id) : '';
    let kind: StatementKind = 'adjustment';
    let invoiceNo: string | null = null;
    let saleId: string | null = null;
    let lineCount = 0;
    let method: string | null = null;
    if (entry.source_type === 'sale') {
      const sale = sourceId ? await saleOf(sourceId) : undefined;
      kind = 'sale';
      invoiceNo = sale ? String(sale.invoice_no) : null;
      saleId = sale ? String(sale.id) : null;
      lineCount = sale ? n(sale.line_count) : 0;
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
      balance: running,
    });
  }

  const display = range
    ? all.filter(
        (row) =>
          String(row.entry.business_date) >= range.from &&
          String(row.entry.business_date) <= range.to,
      )
    : all;
  const openingBalance = range
    ? all
        .filter((row) => String(row.entry.business_date) < range.from)
        .reduce((sum, row) => sum + n(row.entry.amount), 0)
    : 0;
  return {
    rows: display,
    openingBalance,
    balance: running,
    lastPaymentAt,
  };
}

/** CSV of the statement rows the caller formatted for the active language. */
export function statementCsv(rows: readonly StatementCsvRow[]): string {
  const header = ['date', 'description', 'debit', 'credit', 'balance'];
  return [header.join(',')]
    .concat(
      rows.map((row) =>
        [
          row.date,
          row.description,
          rupeesCsv(row.debit),
          rupeesCsv(row.credit),
          rupeesCsv(row.balance),
        ]
          .map(csvCell)
          .join(','),
      ),
    )
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
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.date) ||
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
      await keepPromises(w, input.customerId);
      return payment;
    },
    { now, actor: ctx.staff_id },
  );
}

/** Marks open promises kept when this payment covered them (07 §5, screens/12). */
async function keepPromises(
  w: { table: TableSource['table'] },
  customerId: string,
): Promise<void> {
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
      await (w.table('promises') as Table<SyncedRow>).update(promise.id, {
        status: 'kept',
      });
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
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.promisedOn) ||
    input.promisedOn < options.today
  )
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
    { now, actor },
  );
}

/**
 * Recomputes open promises once a day (screens/12): kept when payments since the promise
 * cover it or the balance is cleared; broken the day after the promised date.
 */
export async function refreshPromises(
  db: BikriDb,
  options: { today: string; now?: number },
): Promise<number> {
  const promises = (await db.promises.toArray()).filter(
    (p) => !p.deleted_at && p.status === 'open',
  );
  if (promises.length === 0) return 0;
  const now = options.now ?? Date.now();
  const updates: { id: string; status: 'kept' | 'broken' }[] = [];
  for (const promise of promises) {
    const entries = await db.ledger_entries
      .where('[party_type+party_id+created_at]')
      .between(
        ['customer', String(promise.customer_id), -Infinity],
        ['customer', String(promise.customer_id), Infinity],
      )
      .toArray();
    const balance = entries.reduce((sum, e) => sum + n(e.amount), 0);
    const since = entries
      .filter(
        (e) =>
          e.source_type === 'payment' &&
          n(e.created_at) >= n(promise.created_at),
      )
      .reduce((sum, e) => sum - n(e.amount), 0);
    const amount = promise.amount === null ? null : Number(promise.amount ?? 0);
    if (balance <= 0 || (amount !== null && since >= amount))
      updates.push({ id: promise.id, status: 'kept' });
    else if (options.today > String(promise.promised_on))
      updates.push({ id: promise.id, status: 'broken' });
  }
  if (updates.length === 0) return 0;
  await writeAction(
    db,
    async (w) => {
      for (const update of updates)
        await w.update('promises', update.id, { status: update.status });
    },
    { now },
  );
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
  const payments = (
    await (src.table('payments') as Table<SyncedRow>).toArray()
  ).filter((p) => p.direction === 'in' && p.purpose === 'customer_payment');
  const lastPayment = new Map<string, number>();
  for (const p of payments) {
    const key = String(p.party_id);
    lastPayment.set(key, Math.max(lastPayment.get(key) ?? 0, n(p.created_at)));
  }
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
      lastPaymentAt: lastPayment.get(customer.customer.id) ?? null,
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
              : new Date(row.lastPaymentAt).toISOString().slice(0, 10),
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
  const amount = formatMoney(input.balance, 'intl').replace(/^Rs /u, '');
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
