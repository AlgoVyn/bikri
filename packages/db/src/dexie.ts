import type { LedgerTable, MasterTable, OpRow } from '@bikri/core';
import Dexie, { type DexieOptions, type Table } from 'dexie';

/**
 * Till database (02 §3). One Dexie database per tenant, named `bikri-<tenant_id>` (D-073);
 * rows carry no tenant_id. Index strings list only indexed fields; Dexie stores every column.
 */
export const DEXIE_SCHEMA_V1 = {
  // master
  shop: 'id',
  branches: 'id, deleted_at',
  devices: 'id, branch_id',
  staff: 'id, active, deleted_at',
  categories: 'id, sort_order, deleted_at',
  products: 'id, sku, category_id, name_en, updated_at, deleted_at',
  product_barcodes: 'id, barcode, product_id, deleted_at',
  customers: 'id, name, phone, deleted_at',
  suppliers: 'id, name, deleted_at',
  expense_categories: 'id, code, sort_order',
  promises: 'id, customer_id, [status+promised_on]',
  sync_conflicts: 'id, row_id, at',
  // ledger
  sales:
    'id, &invoice_no, business_date, customer_id, created_at, [device_id+invoice_seq], status',
  sale_lines: 'id, sale_id, product_id',
  payments:
    'id, business_date, sale_id, [party_type+party_id], [device_id+created_at]',
  refunds: 'id, sale_id, business_date, [device_id+created_at]',
  refund_lines: 'id, refund_id, sale_line_id',
  sale_voids: 'id, &sale_id',
  ledger_entries: 'id, [party_type+party_id+created_at], source_id',
  stock_movements: 'id, [product_id+created_at], business_date',
  purchases: 'id, [supplier_id+created_at], business_date',
  purchase_lines: 'id, purchase_id, product_id',
  supplier_returns: 'id, [supplier_id+created_at], purchase_id, business_date',
  supplier_return_lines: 'id, return_id, product_id, purchase_line_id',
  expenses: 'id, business_date, category_id, [device_id+created_at]',
  cash_moves: 'id, [device_id+created_at]',
  day_closes: 'id, [device_id+period_end], business_date',
  audit_log: 'id, [entity+entity_id], created_at',
  // local-only
  outbox: '++seq, &op_id, status, created_at, [tbl+row_id]',
  kv: 'key',
  carts: 'id',
  held_bills: 'id, created_at',
  file_queue: '++id, status',
  print_jobs: 'id, status, created_at',
  stock_levels: 'product_id',
  party_balances: '[party_type+party_id]',
  pull_shadow: '[tbl+id]',
} as const;

export type DexieTableName = keyof typeof DEXIE_SCHEMA_V1;

export const LOCAL_ONLY_TABLES = [
  'outbox',
  'kv',
  'carts',
  'held_bills',
  'file_queue',
  'print_jobs',
  'stock_levels',
  'party_balances',
  'pull_shadow',
] as const satisfies readonly DexieTableName[];

/** Database name for a tenant (D-073). */
export function tenantDbName(tenantId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) {
    throw new Error(`invalid tenant id '${tenantId}'`);
  }
  return `bikri-${tenantId}`;
}

/** Any synced row: ULID id plus columns named as in 02 §2 (no tenant_id). */
export type SyncedRow = OpRow & { id: string };

export type MasterRow = SyncedRow & {
  created_at: number;
  updated_at: number;
  deleted_at?: number | null;
  /** Last server revision seen; 0 until the row has been pushed and pulled back. */
  rev: number;
  updated_by?: string | null;
};

export type OutboxStatus = 'pending' | 'failed';

/** 02 §3.1 / 03 §3. */
export type OutboxEntry = {
  seq?: number;
  op_id: string;
  tx_id: string;
  tbl: MasterTable | LedgerTable;
  kind: 'insert' | 'upsert' | 'delete';
  row_id: string;
  row?: OpRow;
  base_rev?: number;
  changed_fields?: string[];
  /** Delete ops: who deleted (the server checks the permission, D-104). */
  updated_by?: string | null;
  created_at: number;
  status: OutboxStatus;
  attempts: number;
  last_error?: string;
};

export type KvRow = { key: string; value: unknown };
export type StockLevel = { product_id: string; on_hand_milli: number };
export type PartyType = 'customer' | 'supplier';
export type PartyBalance = {
  party_type: PartyType;
  party_id: string;
  balance: number;
  last_activity_at: number;
  oldest_unpaid_at: number | null;
};

export type CartLine = {
  key: string;
  product_id: string | null;
  name: string;
  sku: string;
  qty_milli: number;
  unit_price: number;
  discount_type?: 'amount' | 'percent';
  discount_value: number;
  unit_cost: number;
  image_key?: string;
  /** Product price when added; `unit_price` below it is a price override (screens/05). */
  list_price?: number;
  /** Serial no / IMEI (0–60 chars). A line with a note never merges. */
  note?: string;
  track_stock?: 0 | 1;
  unit?: string;
};

/** A manager approval given on this cart (05 §4.1); written to audit_log with the sale. */
export type CartOverride = { permission: string; approved_by: string };

/** A cart opened by "Void & reissue": on payment the old bill is voided in the same action. */
export type CartReissue = { sale_id: string; void_id: string; reason: string };

export type Cart = {
  id: 'c1' | 'c2' | 'c3';
  customer_id?: string | null;
  lines: CartLine[];
  bill_discount?: { type: 'amount' | 'percent'; value: number } | null;
  note: string;
  updated_at: number;
  overrides?: CartOverride[];
  reissue?: CartReissue | null;
};

export type HeldBill = Omit<Cart, 'id'> & {
  id: string;
  held_at: number;
  held_by: string;
  label: string;
  created_at: number;
};

export type PrintJob = {
  id: string;
  sale_id?: string;
  refund_id?: string;
  day_close_id?: string;
  supplier_return_id?: string;
  kind: 'sale' | 'refund' | 'test' | 'day_close' | 'statement' | 'supplier';
  status: 'queued' | 'printing' | 'done' | 'failed';
  error?: string;
  /** Prints "REPRINT" under the title (screens/07 AC 3). */
  reprint?: boolean;
  created_at: number;
};

export type FileQueueEntry = {
  id?: number;
  kind: 'product_image' | 'logo';
  target_id: string;
  blob: Blob;
  sha256: string;
  status: 'pending' | 'uploading' | 'failed';
};

type Rows<T> = Table<T, string>;

export class BikriDb extends Dexie {
  readonly tenantId: string;
  shop!: Rows<MasterRow>;
  branches!: Rows<MasterRow>;
  devices!: Rows<SyncedRow>;
  staff!: Rows<MasterRow>;
  categories!: Rows<MasterRow>;
  products!: Rows<MasterRow>;
  product_barcodes!: Rows<MasterRow>;
  customers!: Rows<MasterRow>;
  suppliers!: Rows<MasterRow>;
  expense_categories!: Rows<MasterRow>;
  promises!: Rows<MasterRow>;
  sync_conflicts!: Rows<SyncedRow>;
  sales!: Rows<SyncedRow>;
  sale_lines!: Rows<SyncedRow>;
  payments!: Rows<SyncedRow>;
  refunds!: Rows<SyncedRow>;
  refund_lines!: Rows<SyncedRow>;
  sale_voids!: Rows<SyncedRow>;
  ledger_entries!: Rows<SyncedRow>;
  stock_movements!: Rows<SyncedRow>;
  purchases!: Rows<SyncedRow>;
  purchase_lines!: Rows<SyncedRow>;
  supplier_returns!: Rows<SyncedRow>;
  supplier_return_lines!: Rows<SyncedRow>;
  expenses!: Rows<SyncedRow>;
  cash_moves!: Rows<SyncedRow>;
  day_closes!: Rows<SyncedRow>;
  audit_log!: Rows<SyncedRow>;
  outbox!: Table<OutboxEntry, number>;
  kv!: Rows<KvRow>;
  carts!: Rows<Cart>;
  held_bills!: Rows<HeldBill>;
  file_queue!: Table<FileQueueEntry, number>;
  print_jobs!: Rows<PrintJob>;
  stock_levels!: Rows<StockLevel>;
  party_balances!: Table<PartyBalance, [PartyType, string]>;
  pull_shadow!: Table<
    { tbl: string; id: string; row: OpRow },
    [string, string]
  >;

  constructor(tenantId: string, options?: DexieOptions) {
    super(tenantDbName(tenantId), options);
    this.tenantId = tenantId;
    this.version(1).stores(DEXIE_SCHEMA_V1);
  }
}

/** Opens (creating if needed) the database of one tenant. */
export function openTenantDb(
  tenantId: string,
  options?: DexieOptions,
): BikriDb {
  return new BikriDb(tenantId, options);
}

/** Deletes a tenant's local database ("Leave this shop", T-034). */
export function deleteTenantDb(
  tenantId: string,
  options?: DexieOptions,
): Promise<void> {
  return new Dexie(tenantDbName(tenantId), options).delete();
}
