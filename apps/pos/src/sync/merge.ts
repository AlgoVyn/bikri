/**
 * Applies server rows to the till (03 §4.2): a row with a pending local op stays local and is kept
 * in pull_shadow; ledger rows new to this till update the stock / balance caches.
 */
import type { SyncedRow } from '@bikri/db';
import type { Table, Transaction } from 'dexie';
import { applyLedgerEntry, applyStockMovement } from '../data/caches.ts';
import { isLedgerTable, isPulledTable } from './tables.ts';

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

/** Must run inside a rw transaction over the touched tables, outbox, pull_shadow and caches. */
export async function mergeRows(
  tx: Transaction,
  rows: ServerRow[],
  opts: { caches: boolean },
): Promise<number> {
  let applied = 0;
  const pendingKeys = new Set<string>();
  const ids = rows.map((r) => [r.tbl, r.row.id] as [string, string]);
  if (ids.length > 0) {
    const pending = await tx
      .table('outbox')
      .where('[tbl+row_id]')
      .anyOf(ids)
      .toArray();
    for (const p of pending as {
      tbl: string;
      row_id: string;
      status?: string;
    }[]) {
      // A failed op will not be pushed until the user retries it, so it must not hide
      // every later server change for the same row.
      if (p.status !== 'pending' && p.status !== 'sending') continue;
      pendingKeys.add(`${p.tbl}\u0000${p.row_id}`);
    }
  }
  for (const { tbl, row } of rows) {
    if (!isPulledTable(tbl)) continue;
    assertServerRow(tbl, row);
    const table = tx.table(tbl) as Table<SyncedRow, string>;
    if (pendingKeys.has(`${tbl}\u0000${row.id}`)) {
      await tx.table('pull_shadow').put({ tbl, id: row.id, row });
      continue;
    }
    const ledger = isLedgerTable(tbl);
    // A sale is fetched even during a snapshot because its status is derived locally.
    const local =
      ledger && (opts.caches || tbl === 'sales')
        ? ((await table.get(row.id)) as SyncedRow | undefined)
        : undefined;
    const had = ledger && opts.caches ? local !== undefined : true;
    await table.put(tbl === 'sales' ? keepLocalSaleStatus(row, local) : row);
    // A device moved to another branch (or renamed) keeps its local identity; the
    // next invoice must use the new code, not the one stored at enrolment.
    if (tbl === 'devices') {
      const stored = (await tx.table('kv').get('device')) as
        | { value?: { id?: string } }
        | undefined;
      if (stored?.value?.id === row.id) {
        await tx.table('kv').put({
          key: 'device',
          value: {
            ...stored.value,
            name: row.name,
            code: row.device_code,
            branch_id: row.branch_id,
            is_admin: row.is_admin === 1,
          },
        });
      }
    }
    if (ledger && opts.caches && !had) {
      const src = { table: (name: string) => tx.table(name) };
      if (tbl === 'stock_movements') await applyStockMovement(src, row);
      if (tbl === 'ledger_entries') await applyLedgerEntry(src, row);
    }
    applied += 1;
  }
  return applied;
}

/** Table names a merge transaction needs (plus kv for the cursor). */
export function mergeScope(tbls: Iterable<string>): string[] {
  const names = new Set<string>([
    'outbox',
    'pull_shadow',
    'stock_levels',
    'party_balances',
    'stock_movements',
    'ledger_entries',
    'kv',
  ]);
  for (const t of tbls) if (isPulledTable(t)) names.add(t);
  return [...names];
}
