/** Op format pushed by tills (03 §2). Every op carries the `tx_id` of the user action it belongs to. */

/** Master (mutable) tables, 02 §1.1. */
export const MASTER_TABLES = [
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
] as const;

/** Ledger (append-only) tables, 02 §1.1. */
export const LEDGER_TABLES = [
  'sales',
  'sale_lines',
  'payments',
  'refunds',
  'refund_lines',
  'sale_voids',
  'ledger_entries',
  'stock_movements',
  'purchases',
  'purchase_lines',
  'supplier_returns',
  'supplier_return_lines',
  'expenses',
  'cash_moves',
  'day_closes',
  'audit_log',
] as const;

export type MasterTable = (typeof MASTER_TABLES)[number];
export type LedgerTable = (typeof LEDGER_TABLES)[number];
export type SyncedTable = MasterTable | LedgerTable;
export type OpRow = Record<string, unknown>;

/** Most ops a single Dexie transaction (one user action) may write (03 §3, D-054). */
export const MAX_OPS_PER_TX = 200;
/** Lines per bill, refund, delivery or supplier return, so one action stays under the op limit. */
export const MAX_LINES_PER_DOCUMENT = 60;

type OpBase = {
  op_id: string;
  /** ULID shared by every op of one user action; push batches are cut only between tx_ids. */
  tx_id: string;
};

export type InsertOp = OpBase & {
  tbl: LedgerTable;
  kind: 'insert';
  row: OpRow;
};

export type UpsertOp = OpBase & {
  tbl: MasterTable;
  kind: 'upsert';
  row: OpRow;
  /** 0 when creating. */
  base_rev: number;
  /** Fields the user changed (empty when creating). */
  changed_fields: string[];
};

export type DeleteOp = OpBase & {
  tbl: MasterTable;
  kind: 'delete';
  row_id: string;
  base_rev: number;
};

export type Op = InsertOp | UpsertOp | DeleteOp;

const MASTER_SET: ReadonlySet<string> = new Set(MASTER_TABLES);
const LEDGER_SET: ReadonlySet<string> = new Set(LEDGER_TABLES);

export function isMasterTable(tbl: string): tbl is MasterTable {
  return MASTER_SET.has(tbl);
}

export function isLedgerTable(tbl: string): tbl is LedgerTable {
  return LEDGER_SET.has(tbl);
}

/** Columns a till never sends (03 §2): server-managed values and the tenant. */
export const SERVER_MANAGED_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  '*': ['tenant_id', 'rev'],
  products: ['avg_cost'],
  sales: ['status'],
};

/** `row` for an op: drops tenant_id, rev and table-specific server-managed columns. */
export function opRow(tbl: SyncedTable, row: OpRow): OpRow {
  const drop = new Set([
    ...(SERVER_MANAGED_COLUMNS['*'] ?? []),
    ...(SERVER_MANAGED_COLUMNS[tbl] ?? []),
  ]);
  const out: OpRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (!drop.has(key)) out[key] = value;
  }
  return out;
}
