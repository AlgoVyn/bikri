/**
 * Applies server rows to the till (03 §4.2): a row with a pending local op stays local and is kept
 * in pull_shadow; ledger rows new to this till update the stock / balance caches.
 */
import type { SyncedRow } from '@bikri/db';
import type { Table, Transaction } from 'dexie';
import { applyLedgerEntries, applyStockMovements } from '../data/caches.ts';
import { isPulledTable } from './tables.ts';

export type ServerRow = { tbl: string; row: SyncedRow };

/** A pulled row that cannot be stored (03 §4.2): quarantined, not retried forever. */
export class PullRowError extends Error {
  readonly tbl: string;
  readonly id: string;
  constructor(message: string, tbl: string, id: string) {
    super(message);
    this.name = 'PullRowError';
    this.tbl = tbl;
    this.id = id;
  }
}

/** The shared row shape: scalar columns only, safe integers, bounded strings and a ULID id. */
function assertServerRow(tbl: string, row: SyncedRow): void {
  if (
    row === null ||
    typeof row !== 'object' ||
    typeof row.id !== 'string' ||
    row.id === ''
  )
    throw new PullRowError('missing id', tbl, '');
  for (const [column, value] of Object.entries(row)) {
    if (value === null) continue;
    if (typeof value === 'string') {
      if (value.length > 4_000)
        throw new PullRowError(`column ${column} is too long`, tbl, row.id);
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value))
        throw new PullRowError(
          `column ${column} is not an integer`,
          tbl,
          row.id,
        );
      continue;
    }
    if (typeof value === 'boolean') continue;
    throw new PullRowError(`column ${column} is not a scalar`, tbl, row.id);
  }
}

/** `paid` < `part_refunded` < `refunded` < `void` (02 §4); a local document is never less refunded. */
const STATUS_RANK: Record<string, number> = {
  paid: 0,
  part_refunded: 1,
  refunded: 2,
  void: 3,
};

/**
 * A local refund or void updates `sales.status` without an outbox op (the server derives it),
 * so a pull can deliver the server's older status while the refund is still unsynced. Keep the
 * local status when it is further along; the server's newer status wins once it catches up.
 */
function keepLocalSaleStatus(
  server: SyncedRow,
  local: SyncedRow | undefined,
): SyncedRow {
  if (local === undefined) return server;
  const serverStatus = String(server.status ?? '');
  const localStatus = String(local.status ?? '');
  return (STATUS_RANK[localStatus] ?? 0) > (STATUS_RANK[serverStatus] ?? 0)
    ? { ...server, status: localStatus }
    : server;
}

/**
 * The server does not store `refund_lines.business_date` (a till-only column, Dexie V10),
 * so derive it from the refund before the row is stored or parked in `pull_shadow`.
 */
async function withRefundDates(
  tx: Transaction,
  rows: ServerRow[],
): Promise<ServerRow[]> {
  const lineRows = rows.filter((entry) => entry.tbl === 'refund_lines');
  if (lineRows.length === 0) return rows;
  const refundIds = [
    ...new Set(lineRows.map((entry) => String(entry.row.refund_id))),
  ];
  const dates = new Map<string, string>();
  // The refund header and its lines normally arrive on the same pull page, before
  // either is written. Read the incoming refunds first; the table lookup alone used
  // to miss them and store every line without its business_date.
  for (const entry of rows) {
    if (entry.tbl !== 'refunds') continue;
    const id = entry.row.id;
    const date = entry.row.business_date;
    if (typeof id === 'string' && typeof date === 'string' && date !== '')
      dates.set(id, date);
  }
  const missing = refundIds.filter((id) => !dates.has(id));
  if (missing.length > 0) {
    const refunds = (await (
      tx.table('refunds') as Table<SyncedRow, string>
    ).bulkGet(missing)) as (SyncedRow | undefined)[];
    for (const refund of refunds)
      if (refund) dates.set(String(refund.id), String(refund.business_date));
  }
  if (dates.size === 0) return rows;
  return rows.map((entry) => {
    if (entry.tbl !== 'refund_lines') return entry;
    const date = dates.get(String(entry.row.refund_id));
    if (date === undefined || entry.row.business_date === date) return entry;
    return { tbl: entry.tbl, row: { ...entry.row, business_date: date } };
  });
}

/** Must run inside a rw transaction over the touched tables, outbox, pull_shadow and caches. */
export async function mergeRows(
  tx: Transaction,
  incoming: ServerRow[],
  opts: { caches: boolean },
): Promise<number> {
  if (incoming.length === 0) return 0;
  const rows = await withRefundDates(tx, incoming);
  const outbox = tx.table('outbox') as Table<
    { tbl: string; row_id: string; status?: string },
    number
  >;
  const ids = rows.map((r) => [r.tbl, r.row.id] as [string, string]);
  let pending: { tbl: string; row_id: string; status?: string }[];
  if (ids.length <= 200) {
    pending = await outbox.where('[tbl+row_id]').anyOf(ids).toArray();
  } else {
    // A page is up to 500 rows; one probe per row is the wrong shape (one index range
    // per key). A small outbox is cheaper to scan once. If the outbox is itself a large
    // offline backlog, keep the keyed probe: reading thousands of full op payloads for
    // every page would be worse.
    // Two native counts/reads, not `anyOf('pending','sending')`: Dexie's anyOf falls
    // back to one cursor request per row on a duplicate-heavy status index (D-228).
    const [pendingCount, sendingCount] = await Promise.all([
      outbox.where('status').equals('pending').count(),
      outbox.where('status').equals('sending').count(),
    ]);
    const total = pendingCount + sendingCount;
    if (total === 0) {
      // Initial enrolment merges thousands of pages against an empty outbox; do not
      // load two empty arrays for each one.
      pending = [];
    } else if (total <= 2_000) {
      const [pendingRows, sendingRows] = await Promise.all([
        outbox.where('status').equals('pending').toArray(),
        outbox.where('status').equals('sending').toArray(),
      ]);
      pending = [...pendingRows, ...sendingRows];
    } else {
      pending = await outbox.where('[tbl+row_id]').anyOf(ids).toArray();
    }
  }
  const pendingKeys = new Set<string>();
  for (const p of pending) {
    // A failed op will not be pushed until the user retries it, so it must not hide
    // every later server change for the same row.
    if (p.status !== 'pending' && p.status !== 'sending') continue;
    pendingKeys.add(`${p.tbl}\u0000${p.row_id}`);
  }

  const applied: ServerRow[] = [];
  const shadows: {
    tbl: string;
    id: string;
    row: SyncedRow;
    source: 'server';
  }[] = [];
  for (const { tbl, row } of rows) {
    if (!isPulledTable(tbl)) continue;
    assertServerRow(tbl, row);
    if (pendingKeys.has(`${tbl}\u0000${row.id}`)) {
      shadows.push({ tbl, id: row.id, row, source: 'server' });
      continue;
    }
    applied.push({ tbl, row });
  }
  if (shadows.length > 0) {
    const shadowTable = tx.table('pull_shadow') as Table<
      { tbl: string; id: string; row: SyncedRow; source?: 'local' | 'server' },
      [string, string]
    >;
    if (shadows.length === 1)
      await shadowTable.put(shadows[0] as (typeof shadows)[number]);
    else await shadowTable.bulkPut(shadows);
  }

  const byTable = new Map<string, SyncedRow[]>();
  for (const { tbl, row } of applied) {
    const list = byTable.get(tbl) ?? [];
    list.push(row);
    byTable.set(tbl, list);
  }

  for (const [tbl, list] of byTable) {
    const table = tx.table(tbl) as Table<SyncedRow, string>;
    // A single row uses put() so the row-by-row quarantine path still sees the real
    // ConstraintError (bulkPut wraps it in a BulkError, which hides a sale_voids
    // sale_id collision from the recovery logic).
    const write = async (rows: SyncedRow[]) => {
      if (rows.length === 1) await table.put(rows[0] as SyncedRow);
      else await table.bulkPut(rows);
    };
    let had: boolean[] | null = null;
    if (
      opts.caches &&
      (tbl === 'stock_movements' || tbl === 'ledger_entries')
    ) {
      const existing = await table.bulkGet(list.map((row) => row.id));
      had = existing.map((row) => row !== undefined);
    }
    if (tbl === 'sales') {
      // A sale is fetched even during a snapshot because its status is derived locally.
      const locals = await table.bulkGet(list.map((row) => row.id));
      await write(
        list.map((row, index) => keepLocalSaleStatus(row, locals[index])),
      );
    } else {
      await write(list);
    }

    // A device moved to another branch (or renamed) keeps its local identity; the
    // next invoice must use the new code, not the one stored at enrolment.
    if (tbl === 'devices') {
      const stored = (await tx.table('kv').get('device')) as
        | { value?: { id?: string } }
        | undefined;
      const local = stored?.value?.id
        ? list.find((row) => row.id === stored.value?.id)
        : undefined;
      if (stored?.value?.id && local) {
        await tx.table('kv').put({
          key: 'device',
          value: {
            ...stored.value,
            name: local.name,
            code: local.device_code,
            branch_id: local.branch_id,
            is_admin: local.is_admin === 1,
          },
        });
      }
    }

    if (opts.caches && tbl === 'stock_movements') {
      // Only newly stored movements move the cache; a replayed row must not double-count.
      const fresh = list.filter((_, index) => !had?.[index]);
      await applyStockMovements({ table: (name) => tx.table(name) }, fresh);
    }
    if (opts.caches && tbl === 'ledger_entries') {
      const fresh = list.filter((_, index) => !had?.[index]);
      // Chronological order lets the cache take the incremental path for new debits.
      const ordered = [...fresh].sort(
        (a, b) =>
          Number(a.created_at ?? 0) - Number(b.created_at ?? 0) ||
          String(a.id).localeCompare(String(b.id)),
      );
      await applyLedgerEntries({ table: (name) => tx.table(name) }, ordered);
    }
  }
  return applied.length;
}

/**
 * Table names a merge transaction needs (plus kv for the cursor). Snapshot pages disable
 * caches and rebuild them once at the end, so they must not lock the cache stores (or
 * the ledger/movement stores they would not touch) on every page.
 */
export function mergeScope(tbls: Iterable<string>, caches = false): string[] {
  const names = new Set<string>(['outbox', 'pull_shadow', 'kv']);
  if (caches)
    for (const name of [
      'stock_levels',
      'party_balances',
      'stock_movements',
      'ledger_entries',
    ])
      names.add(name);
  for (const t of tbls) if (isPulledTable(t)) names.add(t);
  // A refund line takes its business date from the refund (till-only column).
  if (names.has('refund_lines')) names.add('refunds');
  return [...names];
}
