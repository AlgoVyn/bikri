/** Shared database definitions: D1 migrations (../migrations) and the till's Dexie schema. */
export const packageName = '@bikri/db';

export {
  BikriDb,
  type Cart,
  type CartLine,
  DEXIE_SCHEMA_V1,
  type DexieTableName,
  deleteTenantDb,
  type FileQueueEntry,
  type HeldBill,
  type KvRow,
  LOCAL_ONLY_TABLES,
  type MasterRow,
  type OutboxEntry,
  type OutboxStatus,
  openTenantDb,
  type PartyBalance,
  type PartyType,
  type PrintJob,
  type StockLevel,
  type SyncedRow,
  tenantDbName,
} from './dexie.ts';
export { EXPENSE_CATEGORY_TEMPLATES } from './seed.ts';
