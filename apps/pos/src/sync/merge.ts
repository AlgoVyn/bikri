/**
 * Applies server rows to the till (03 §4.2): a row with a pending local op stays local and is kept
 * in pull_shadow; ledger rows new to this till update the stock / balance caches.
 */
import type { SyncedRow } from '@bikri/db';
import type { Table, Transaction } from 'dexie';
import { applyLedgerEntry, applyStockMovement } from '../data/caches.ts';
import { isLedgerTable, isPulledTable } from './tables.ts';

export type ServerRow = { tbl: string; row: SyncedRow };

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
    for (const p of pending as { tbl: string; row_id: string }[])
      pendingKeys.add(`${p.tbl}\u0000${p.row_id}`);
  }
  for (const { tbl, row } of rows) {
    if (!isPulledTable(tbl)) continue;
    const table = tx.table(tbl) as Table<SyncedRow, string>;
    if (pendingKeys.has(`${tbl}\u0000${row.id}`)) {
      await tx.table('pull_shadow').put({ tbl, id: row.id, row });
      continue;
    }
    const ledger = isLedgerTable(tbl);
    const had =
      ledger && opts.caches ? (await table.get(row.id)) !== undefined : true;
    await table.put(row);
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
