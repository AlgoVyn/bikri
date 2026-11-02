import {
  LEDGER_TABLES,
  MASTER_TABLES,
  SYNC_EXPORT_ORDER,
  type SyncedTable,
} from '@bikri/core';
import type { DexieTableName } from '@bikri/db';

/** Synced tables a till stores, in snapshot order (03 §4.3). */
export const PULLED_TABLES =
  SYNC_EXPORT_ORDER satisfies readonly DexieTableName[];

export type PulledTable = (typeof PULLED_TABLES)[number];

const PULLED: ReadonlySet<string> = new Set(PULLED_TABLES);
const LEDGER: ReadonlySet<string> = new Set(LEDGER_TABLES);
const MASTER: ReadonlySet<string> = new Set(MASTER_TABLES);

export const isPulledTable = (t: string): t is PulledTable => PULLED.has(t);
export const isLedgerTable = (t: string): boolean => LEDGER.has(t);
export const isMasterTable = (t: string): t is SyncedTable => MASTER.has(t);
