/** Synced-table metadata for the Worker (02 §1.1, 03 §4.3), from packages/db/src/tables.ts. */
import { LEDGER_TABLES, MASTER_TABLES, type SyncedTable } from '@bikri/core';
import { type D1Table, TABLE_COLUMNS } from '@bikri/db/tables';

/** Tables a till receives through pull and snapshot, parents before children (03 §4.3). */
export const SNAPSHOT_TABLES = [
  'shop',
  'branches',
  'devices',
  'staff',
  'categories',
  'products',
  'product_barcodes',
  'customers',
  'suppliers',
  'expense_categories',
  'promises',
  ...LEDGER_TABLES,
  'sync_conflicts',
] as const;

export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

/** Columns never sent to a till (besides tenant_id). */
const HIDDEN: Partial<Record<D1Table, readonly string[]>> = {
  devices: ['token_hash'],
};

/** The columns of a row as a till sees it: every column except tenant_id and hidden ones. */
export function clientColumns(tbl: D1Table): readonly string[] {
  const hidden = new Set(['tenant_id', ...(HIDDEN[tbl] ?? [])]);
  return TABLE_COLUMNS[tbl].filter((c) => !hidden.has(c));
}

export function columnsOf(tbl: D1Table): readonly string[] {
  return TABLE_COLUMNS[tbl];
}

export function isSyncedTable(tbl: string): tbl is SyncedTable {
  return (
    (MASTER_TABLES as readonly string[]).includes(tbl) ||
    (LEDGER_TABLES as readonly string[]).includes(tbl)
  );
}

/** D1 allows 32 arguments per SQL function call. */
const MAX_FN_ARGS = 32;

/**
 * `json_object(...)` of a table's client columns, nested with `json_insert` when it would pass
 * D1's 32-argument limit. (`json_patch` would drop null values, so it is not used: D-103.)
 */
export function rowJsonExpr(tbl: D1Table, alias = ''): string {
  const cols = clientColumns(tbl);
  const ref = (c: string) => (alias ? `${alias}.${c}` : c);
  const first = cols.slice(0, MAX_FN_ARGS / 2);
  let expr = `json_object(${first.map((c) => `'${c}', ${ref(c)}`).join(', ')})`;
  const rest = cols.slice(MAX_FN_ARGS / 2);
  const perInsert = Math.floor((MAX_FN_ARGS - 1) / 2);
  for (let i = 0; i < rest.length; i += perInsert) {
    const part = rest.slice(i, i + perInsert);
    expr = `json_insert(${expr}, ${part.map((c) => `'$.${c}', ${ref(c)}`).join(', ')})`;
  }
  return expr;
}

/** A SELECT list of the client columns. */
export function selectList(tbl: D1Table): string {
  return clientColumns(tbl).join(', ');
}

/**
 * Parents before children for applying one push without deferred foreign keys (D-104): every
 * foreign key of a synced table points to a table earlier in this list (or to itself).
 */
export const APPLY_ORDER = [
  'shop',
  'branches',
  'staff',
  'categories',
  'products',
  'product_barcodes',
  'customers',
  'suppliers',
  'expense_categories',
  'promises',
  'sales',
  'sale_lines',
  'refunds',
  'refund_lines',
  'sale_voids',
  'purchases',
  'purchase_lines',
  'supplier_returns',
  'supplier_return_lines',
  'payments',
  'ledger_entries',
  'stock_movements',
  'expenses',
  'cash_moves',
  'day_closes',
  'audit_log',
] as const;

const RANK = new Map<string, number>(APPLY_ORDER.map((t, i) => [t, i]));
export function applyRank(tbl: string): number {
  return RANK.get(tbl) ?? APPLY_ORDER.length;
}
