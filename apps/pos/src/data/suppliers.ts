import { businessDate, newId } from '@bikri/core';
import type { BikriDb, MasterRow, PartyBalance, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import { csvCell, rupeesCsv } from '../lib/csv.ts';
import type { SortDirection } from '../lib/sort.ts';
import { rowsAnyOfTable } from './bulk.ts';
import type { TableSource } from './caches.ts';
import { deviceInfo } from './localTenant.ts';
import type { LedgerContext } from './products.ts';
import { type StatementItem, statementItemLabel } from './udhaar.ts';
import { writeAction, writeScope } from './write.ts';

const n = (v: unknown): number => Number(v ?? 0);
const NAME_COLLATOR = new Intl.Collator();

export type SupplierInput = {
  name: string;
  phone?: string | null;
  address?: string;
  note?: string;
  opening?: number;
};

export type SupplierRow = {
  supplier: MasterRow;
  searchName?: string;
  searchDigits?: string;
  balance: number;
  /** The latest delivery's business date (`YYYY-MM-DD`), not its entry time. */
  lastDeliveryDate: string | null;
};

export type SupplierSort = 'name' | 'balance' | 'last';

/** Natural first-click order for each supplier column. */
export const SUPPLIER_SORT_DIRECTIONS: Record<SupplierSort, SortDirection> = {
  name: 'asc',
  balance: 'desc',
  last: 'desc',
};

export function defaultSupplierSortDirection(
  sort: SupplierSort,
): SortDirection {
  return SUPPLIER_SORT_DIRECTIONS[sort];
}

export type SupplierList = {
  rows: SupplierRow[];
  totalOwed: number;
  /** Shop-wide supplier count, independent of the search/filter. */
  totalCount: number;
};

export class SupplierBalanceError extends Error {
  constructor() {
    super('Supplier has a balance');
    this.name = 'SupplierBalanceError';
  }
}

export type SupplierStatementKind =
  | 'purchase'
  | 'payment'
  | 'return'
  | 'refund'
  | 'opening'
  | 'adjustment';

export type SupplierStatementEntry = {
  entry: SyncedRow;
  kind: SupplierStatementKind;
  invoiceNo: string | null;
  lineCount: number;
  method: string | null;
  reason: string | null;
  note: string;
  got: number;
  paid: number;
  balance: number;
  /** Delivery line details; only filled for detailed exports. */
  items?: StatementItem[];
};

export type SupplierStatement = {
  rows: SupplierStatementEntry[];
  openingBalance: number;
  balance: number;
  /** Older entries exist beyond the requested page. */
  hasMore: boolean;
};

export function supplierBalance(db: BikriDb, id: string): Promise<number> {
  return db.party_balances
    .get(['supplier', id])
    .then((row) => row?.balance ?? 0);
}

async function balancesOf(
  src: TableSource,
): Promise<Map<string, PartyBalance>> {
  const rows = await (src.table('party_balances') as Table<PartyBalance>)
    .where('[party_type+party_id]')
    .between(['supplier', ''], ['supplier', '\uffff'])
    .toArray();
  return new Map(rows.map((row) => [row.party_id, row]));
}

export type SupplierListData = {
  rows: SupplierRow[];
  totalOwed: number;
  totalCount: number;
};

export type SupplierListOptions = {
  query?: string;
  sort?: SupplierSort;
  direction?: SortDirection;
};

/** Loads suppliers, balances and last-delivery dates once; filtering stays in memory. */
export async function loadSupplierListData(
  src: TableSource,
): Promise<SupplierListData> {
  const balances = await balancesOf(src);
  const purchases = await (
    src.table('purchases') as Table<SyncedRow>
  ).toArray();
  const last = new Map<string, string>();
  for (const purchase of purchases) {
    const key = String(purchase.supplier_id);
    const date = String(purchase.business_date ?? '');
    if (date > (last.get(key) ?? '')) last.set(key, date);
  }
  const all: SupplierRow[] = [];
  for (const supplier of (
    await (src.table('suppliers') as Table<MasterRow>).toArray()
  ).filter((row) => !row.deleted_at)) {
    all.push({
      supplier,
      searchName: String(supplier.name ?? '').toLowerCase(),
      searchDigits: String(supplier.phone ?? '').replace(/\D/gu, ''),
      balance: balances.get(supplier.id)?.balance ?? 0,
      lastDeliveryDate: last.get(supplier.id) ?? null,
    });
  }
  return {
    rows: all,
    // screens/13: "total you owe suppliers" is a shop total, not a search result
    // (same rule as the customer list, D-126).
    totalOwed: all.reduce((sum, row) => sum + Math.max(0, row.balance), 0),
    totalCount: all.length,
  };
}

/** Pure filter/sort for the loaded supplier directory. */
export function filterSupplierList(
  data: SupplierListData,
  options: SupplierListOptions = {},
): SupplierList {
  const query = (options.query ?? '').trim().toLowerCase();
  const words = query.split(/\s+/u).filter(Boolean);
  const digits = query.replace(/\D/gu, '').replace(/^0+/u, '');
  const rows = data.rows.filter((row) => {
    if (query === '') return true;
    const name =
      row.searchName ?? String(row.supplier.name ?? '').toLowerCase();
    const phone =
      row.searchDigits ?? String(row.supplier.phone ?? '').replace(/\D/gu, '');
    return (
      words.every((word) => name.includes(word)) ||
      (digits.length >= 3 && phone.includes(digits))
    );
  });
  const sort = options.sort ?? 'name';
  const sign =
    (options.direction ?? defaultSupplierSortDirection(sort)) === 'asc'
      ? 1
      : -1;
  const byName = (a: SupplierRow, b: SupplierRow) =>
    NAME_COLLATOR.compare(String(a.supplier.name), String(b.supplier.name));
  rows.sort((a, b) => {
    if (sort === 'last') {
      if (a.lastDeliveryDate === null || b.lastDeliveryDate === null) {
        if (a.lastDeliveryDate === null && b.lastDeliveryDate === null)
          return byName(a, b);
        return a.lastDeliveryDate === null ? 1 : -1;
      }
      return (
        sign * a.lastDeliveryDate.localeCompare(b.lastDeliveryDate) ||
        byName(a, b)
      );
    }
    if (sort === 'balance')
      return sign * (a.balance - b.balance) || byName(a, b);
    return sign * byName(a, b);
  });
  return {
    rows,
    totalOwed: data.totalOwed,
    totalCount: data.totalCount,
  };
}

/** Convenience wrapper for callers that do not already hold the directory. */
export async function supplierList(
  src: TableSource,
  options: SupplierListOptions = {},
): Promise<SupplierList> {
  return filterSupplierList(await loadSupplierListData(src), options);
}

function clean(input: SupplierInput) {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new RangeError('name is required');
  return {
    name,
    phone: input.phone ?? '',
    address: (input.address ?? '').trim().slice(0, 120),
    note: (input.note ?? '').trim().slice(0, 200),
  };
}

/** New supplier with an optional opening balance (screens/13). */
export async function createSupplier(
  db: BikriDb,
  input: SupplierInput,
  ctx: LedgerContext,
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  const opening = input.opening ?? 0;
  if (!Number.isSafeInteger(opening) || opening < 0)
    throw new RangeError('opening balance must be non-negative');
  const fields = clean(input);
  return writeAction(
    db,
    async (w) => {
      const row = await w.create('suppliers', fields);
      if (opening > 0)
        await w.insert('ledger_entries', {
          id: newId(now),
          party_type: 'supplier',
          party_id: row.id,
          amount: opening,
          source_type: 'opening',
          source_id: null,
          note: '',
          branch_id: ctx.branch_id,
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          business_date: businessDate(now, ctx.timeZone),
          created_at: now,
        });
      return row;
    },
    {
      now,
      actor,
      tables: writeScope('suppliers', 'ledger_entries', 'party_balances'),
    },
  );
}

export async function updateSupplier(
  db: BikriDb,
  id: string,
  input: SupplierInput,
  actor: string | null,
  now = Date.now(),
): Promise<MasterRow> {
  const current = await db.suppliers.get(id);
  if (!current || current.deleted_at)
    throw new RangeError('supplier not found');
  const fields = clean(input);
  return writeAction(db, (w) => w.update('suppliers', id, fields), {
    now,
    actor,
    tables: writeScope('suppliers'),
  });
}

/** Soft-deletes a settled supplier. */
export async function deleteSupplier(
  db: BikriDb,
  id: string,
  actor: string | null,
  now = Date.now(),
): Promise<void> {
  if ((await supplierBalance(db, id)) !== 0) throw new SupplierBalanceError();
  const device = await deviceInfo(db);
  await writeAction(
    db,
    async (w) => {
      const before = await w.table<MasterRow, string>('suppliers').get(id);
      await w.remove('suppliers', id);
      await w.insert('audit_log', {
        id: newId(now),
        action: 'party_delete',
        entity: 'suppliers',
        entity_id: id,
        before_json: before
          ? JSON.stringify({ name: before.name, phone: before.phone ?? '' })
          : null,
        after_json: null,
        device_id: device?.id ?? '',
        staff_id: actor ?? '',
        created_at: now,
      });
    },
    { now, actor, tables: writeScope('suppliers', 'audit_log') },
  );
}

export function suppliersCsv(rows: readonly SupplierRow[]): string {
  const header = ['name', 'phone', 'balance', 'last_delivery'];
  return [header.join(',')]
    .concat(
      rows.map((row) =>
        [
          String(row.supplier.name),
          String(row.supplier.phone ?? ''),
          rupeesCsv(row.balance),
          String(row.lastDeliveryDate ?? ''),
        ]
          .map(csvCell)
          .join(','),
      ),
    )
    .join('\r\n');
}

/** Supplier ledger oldest first with the running balance (screens/13). */
export async function supplierStatement(
  src: TableSource,
  supplierId: string,
  limit = Number.POSITIVE_INFINITY,
  range?: { from: string; to: string },
  withItems = false,
): Promise<SupplierStatement> {
  const base = (src.table('ledger_entries') as Table<SyncedRow>).where(
    '[party_type+party_id+business_date+created_at]',
  );
  const from = range?.from ?? '0000-01-01';
  const to = range?.to ?? '9999-12-31';
  const bounds = [
    ['supplier', supplierId, from, 0],
    ['supplier', supplierId, to, Number.MAX_SAFE_INTEGER],
  ] as const;
  const paged = range === undefined && Number.isFinite(limit);
  const take = Math.max(1, Math.floor(limit)) + 1;
  const page = paged
    ? await base.between(bounds[0], bounds[1]).reverse().limit(take).toArray()
    : await base.between(bounds[0], bounds[1]).toArray();
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
      'supplier',
      supplierId,
    ])
  )?.balance;
  const allEntries = async (): Promise<SyncedRow[]> =>
    base
      .between(
        ['supplier', supplierId, '0000-01-01', 0],
        ['supplier', supplierId, '9999-12-31', Number.MAX_SAFE_INTEGER],
      )
      .toArray();
  const balance =
    cachedBalance ??
    (hasMore || range !== undefined
      ? (await allEntries()).reduce((sum, entry) => sum + n(entry.amount), 0)
      : entries.reduce((sum, entry) => sum + n(entry.amount), 0));
  let balances: number[];
  let openingBalance: number;
  if (range !== undefined) {
    // A historical range starts from the balance before its first row, so the
    // running balances on screen and in the exports match the selected period.
    const before = await base
      .between(
        ['supplier', supplierId, '0000-01-01', 0],
        ['supplier', supplierId, range.from, -1],
      )
      .toArray();
    openingBalance = before.reduce((sum, entry) => sum + n(entry.amount), 0);
    let running = openingBalance;
    balances = entries.map((entry) => {
      running += n(entry.amount);
      return running;
    });
  } else {
    // Start from the party's current balance and walk the page backwards, so a page
    // shows the same running balances without reading every earlier entry.
    balances = new Array<number>(entries.length);
    let running = balance;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      balances[index] = running;
      running -= n(entries[index]?.amount);
    }
    openingBalance = running;
  }
  const idsFor = (type: string): string[] => [
    ...new Set(
      entries
        .filter((entry) => entry.source_type === type && entry.source_id)
        .map((entry) => String(entry.source_id)),
    ),
  ];
  const load = async (
    table: string,
    ids: string[],
  ): Promise<Map<string, SyncedRow>> =>
    new Map(
      (await (src.table(table) as Table<SyncedRow, string>).bulkGet(ids))
        .filter((row): row is SyncedRow => row !== undefined)
        .map((row) => [String(row.id), row]),
    );
  const purchases = await load('purchases', idsFor('purchase'));
  const payments = await load('payments', idsFor('payment'));
  const returns = await load('supplier_returns', idsFor('supplier_return'));
  const all: SupplierStatementEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const amount = n(entry.amount);
    const id = entry.source_id ? String(entry.source_id) : '';
    let kind: SupplierStatementKind = 'adjustment';
    let invoiceNo: string | null = null;
    let lineCount = 0;
    let method: string | null = null;
    let reason: string | null = null;
    if (entry.source_type === 'purchase') {
      kind = 'purchase';
      const row = purchases.get(id);
      invoiceNo = row ? String(row.supplier_invoice_no ?? '') : null;
      lineCount = row ? n(row.line_count) : 0;
    } else if (entry.source_type === 'payment') {
      const row = payments.get(id);
      method = row ? String(row.method) : null;
      if (row?.purpose === 'supplier_refund') kind = 'refund';
      else kind = 'payment';
    } else if (entry.source_type === 'supplier_return') {
      kind = 'return';
      const row = returns.get(id);
      reason = row ? String(row.reason) : null;
      lineCount = row ? n(row.line_count) : 0;
    } else if (entry.source_type === 'opening') {
      kind = 'opening';
    }
    all.push({
      entry,
      kind,
      invoiceNo,
      lineCount,
      method,
      reason,
      note: String(entry.note ?? ''),
      got: Math.max(0, amount),
      paid: Math.max(0, -amount),
      balance: balances[index] ?? 0,
    });
  }

  if (withItems) {
    const purchaseIds = [
      ...new Set(
        all
          .filter((row) => row.kind === 'purchase' && row.entry.source_id)
          .map((row) => String(row.entry.source_id)),
      ),
    ];
    const lines = await rowsAnyOfTable<SyncedRow>(
      src.table('purchase_lines') as Table<SyncedRow, string>,
      'purchase_id',
      purchaseIds,
      (row) => String(row.purchase_id),
      // The page already bounds these ids; a table scan would read every line.
      Number.POSITIVE_INFINITY,
    );
    const productIds = [
      ...new Set(lines.map((line) => String(line.product_id))),
    ];
    const products = new Map(
      (
        await (src.table('products') as Table<MasterRow, string>).bulkGet(
          productIds,
        )
      )
        .filter((row): row is MasterRow => row !== undefined)
        .map((row) => [String(row.id), row]),
    );
    const byPurchase = new Map<
      string,
      { lineNo: number; item: StatementItem }[]
    >();
    for (const line of lines) {
      const purchaseId = String(line.purchase_id);
      const product = products.get(String(line.product_id));
      const group = byPurchase.get(purchaseId) ?? [];
      group.push({
        lineNo: n(line.line_no),
        item: {
          // No name snapshot on purchase_lines: use the current catalogue name.
          name:
            String(product?.name_en ?? '').trim() ||
            String(product?.name_ur ?? '').trim() ||
            String(line.product_id),
          qtyMilli: n(line.qty_milli),
          unitPrice: n(line.unit_cost),
          amount: n(line.line_total),
        },
      });
      byPurchase.set(purchaseId, group);
    }
    for (const row of all) {
      if (row.kind !== 'purchase' || !row.entry.source_id) continue;
      row.items = (byPurchase.get(String(row.entry.source_id)) ?? [])
        .sort((a, b) => a.lineNo - b.lineNo)
        .map((entry) => entry.item);
    }
  }

  return { rows: all, openingBalance, balance, hasMore };
}

export function supplierStatementCsv(
  rows: readonly {
    date: string;
    description: string;
    got: number;
    paid: number;
    balance: number;
    items?: readonly StatementItem[];
  }[],
): string {
  const header = ['date', 'description', 'got', 'paid', 'balance'];
  const lines = rows.flatMap((row) => {
    const main = [
      row.date,
      row.description,
      rupeesCsv(row.got),
      rupeesCsv(row.paid),
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
