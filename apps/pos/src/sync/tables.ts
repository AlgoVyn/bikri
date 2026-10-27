import { LEDGER_TABLES, MASTER_TABLES, type SyncedTable } from '@bikri/core';
import type { DexieTableName } from '@bikri/db';

/** Synced tables a till stores, in snapshot order (03 §4.3). */
export const PULLED_TABLES = [
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
] as const satisfies readonly DexieTableName[];

export type PulledTable = (typeof PULLED_TABLES)[number];

const PULLED: ReadonlySet<string> = new Set(PULLED_TABLES);
const LEDGER: ReadonlySet<string> = new Set(LEDGER_TABLES);
const MASTER: ReadonlySet<string> = new Set(MASTER_TABLES);

export const isPulledTable = (t: string): t is PulledTable => PULLED.has(t);
export const isLedgerTable = (t: string): boolean => LEDGER.has(t);
export const isMasterTable = (t: string): t is SyncedTable => MASTER.has(t);
