/** Op format pushed by tills (03 §2). Every op carries the `tx_id` of the user action it belongs to. */

/** Master (mutable) tables, 02 §1.1. */
export const MASTER_TABLES = [
  'shop',
  'branches',
  'staff',
  'categories',
  'products',
  'bundle_items',
  'product_barcodes',
  'customers',
  'suppliers',
  'expense_categories',
  'promises',
  'quotations',
  'quotation_lines',
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

/**
 * Parents before children. Used by the Worker when applying one push, by the export
 * manifests, and by restore so a table is never written before the rows it references.
 * `sync_conflicts` has no foreign keys and is not part of this list.
 */
export const SYNC_IMPORT_ORDER = [
  'shop',
  'branches',
  'staff',
  'categories',
  'products',
  'bundle_items',
  'product_barcodes',
  'customers',
  'suppliers',
  'expense_categories',
  'promises',
  'sales',
  'quotations',
  'quotation_lines',
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

/** Snapshot/export order: devices are server-owned and restore skips them; conflicts are last. */
export const SYNC_EXPORT_ORDER = [
  'shop',
  'branches',
  'devices',
  ...SYNC_IMPORT_ORDER.slice(2),
  'sync_conflicts',
] as const;

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
  products: ['avg_cost', 'on_hand_milli', 'cost_changed_at', 'bundle_since'],
  sales: ['status'],
};

/**
 * Till-only columns denormalised for local range queries. The server neither stores nor
 * returns them, so they must never travel in an op (Dexie V10 adds
 * `refund_lines.business_date` this way).
 */
export const LOCAL_ONLY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  refund_lines: ['business_date'],
};

/** `row` for an op: drops tenant_id, rev, server-managed and till-only columns. */
const DROP_BY_TABLE: Readonly<Record<SyncedTable, ReadonlySet<string>>> =
  Object.fromEntries(
    [...MASTER_TABLES, ...LEDGER_TABLES].map((tbl) => [
      tbl,
      new Set([
        ...(SERVER_MANAGED_COLUMNS['*'] ?? []),
        ...(SERVER_MANAGED_COLUMNS[tbl] ?? []),
        ...(LOCAL_ONLY_COLUMNS[tbl] ?? []),
      ]),
    ]),
  ) as unknown as Record<SyncedTable, ReadonlySet<string>>;

export function opRow(tbl: SyncedTable, row: OpRow): OpRow {
  if (!Object.hasOwn(DROP_BY_TABLE, tbl)) {
    throw new RangeError(`Unknown synced table: ${String(tbl)}`);
  }
  const drop = DROP_BY_TABLE[tbl];
  const out: OpRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (!drop.has(key)) out[key] = value;
  }
  return out;
}
