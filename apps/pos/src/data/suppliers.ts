import { businessDate, newId } from '@bikri/core';
import type { BikriDb, MasterRow, PartyBalance, SyncedRow } from '@bikri/db';
import type { Table } from 'dexie';
import { csvCell, rupeesCsv } from '../lib/csv.ts';
import type { TableSource } from './caches.ts';
import type { LedgerContext } from './products.ts';
import { writeAction } from './write.ts';

const n = (v: unknown): number => Number(v ?? 0);

export type SupplierInput = {
  name: string;
  phone?: string | null;
  address?: string;
  note?: string;
  opening?: number;
};

export type SupplierRow = {
  supplier: MasterRow;
  balance: number;
  lastDeliveryAt: number | null;
};

export type SupplierList = {
  rows: SupplierRow[];
  totalOwed: number;
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
};

export type SupplierStatement = {
  rows: SupplierStatementEntry[];
  openingBalance: number;
  balance: number;
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

/** Suppliers with balances and last delivery (screens/13). */
export async function supplierList(
  src: TableSource,
  options: { query?: string } = {},
): Promise<SupplierList> {
  const query = (options.query ?? '').trim().toLowerCase();
  const words = query.split(/\s+/u).filter(Boolean);
  const digits = query.replace(/\D/gu, '').replace(/^0+/u, '');
  const balances = await balancesOf(src);
  const purchases = await (
    src.table('purchases') as Table<SyncedRow>
  ).toArray();
  const last = new Map<string, number>();
  for (const purchase of purchases) {
    const key = String(purchase.supplier_id);
    last.set(key, Math.max(last.get(key) ?? 0, n(purchase.created_at)));
  }
  const rows: SupplierRow[] = [];
  for (const supplier of (
    await (src.table('suppliers') as Table<MasterRow>).toArray()
  ).filter((row) => !row.deleted_at)) {
    const name = String(supplier.name ?? '').toLowerCase();
    const phone = String(supplier.phone ?? '').replace(/\D/gu, '');
    if (
      query !== '' &&
      !(
        words.every((word) => name.includes(word)) ||
        (digits.length >= 3 && phone.includes(digits))
      )
    )
      continue;
    rows.push({
      supplier,
      balance: balances.get(supplier.id)?.balance ?? 0,
      lastDeliveryAt: last.get(supplier.id) ?? null,
    });
  }
  rows.sort((a, b) =>
    String(a.supplier.name).localeCompare(String(b.supplier.name)),
  );
  return {
    rows,
    totalOwed: rows.reduce((sum, row) => sum + Math.max(0, row.balance), 0),
  };
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
    { now, actor },
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
  await writeAction(db, (w) => w.remove('suppliers', id), { now, actor });
}

export function suppliersCsv(
  rows: readonly SupplierRow[],
  timeZone: string,
): string {
  const header = ['name', 'phone', 'balance', 'last_delivery'];
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
          String(row.supplier.name),
          String(row.supplier.phone ?? ''),
          rupeesCsv(row.balance),
          date(row.lastDeliveryAt),
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
): Promise<SupplierStatement> {
  const entries = (
    await (src.table('ledger_entries') as Table<SyncedRow>)
      .where('[party_type+party_id+created_at]')
      .between(
        ['supplier', supplierId, -Infinity],
        ['supplier', supplierId, Infinity],
      )
      .toArray()
  ).sort(
    (a, b) =>
      n(a.created_at) - n(b.created_at) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const purchases = new Map<string, SyncedRow>();
  const payments = new Map<string, SyncedRow>();
  const returns = new Map<string, SyncedRow>();
  for (const entry of entries) {
    const id = entry.source_id ? String(entry.source_id) : '';
    if (!id) continue;
    if (entry.source_type === 'purchase' && !purchases.has(id)) {
      const row = await (src.table('purchases') as Table<SyncedRow>).get(id);
      if (row) purchases.set(id, row);
    }
    if (entry.source_type === 'payment' && !payments.has(id)) {
      const row = await (src.table('payments') as Table<SyncedRow>).get(id);
      if (row) payments.set(id, row);
    }
    if (entry.source_type === 'supplier_return' && !returns.has(id)) {
      const row = await (src.table('supplier_returns') as Table<SyncedRow>).get(
        id,
      );
      if (row) returns.set(id, row);
    }
  }
  const all: SupplierStatementEntry[] = [];
  let running = 0;
  for (const entry of entries) {
    const amount = n(entry.amount);
    running += amount;
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
      balance: running,
    });
  }
  return { rows: all, openingBalance: 0, balance: running };
}

export function supplierStatementCsv(
  rows: readonly {
    date: string;
    description: string;
    got: number;
    paid: number;
    balance: number;
  }[],
): string {
  const header = ['date', 'description', 'got', 'paid', 'balance'];
  return [header.join(',')]
    .concat(
      rows.map((row) =>
        [
          row.date,
          row.description,
          rupeesCsv(row.got),
          rupeesCsv(row.paid),
          rupeesCsv(row.balance),
        ]
          .map(csvCell)
          .join(','),
      ),
    )
    .join('\r\n');
}
