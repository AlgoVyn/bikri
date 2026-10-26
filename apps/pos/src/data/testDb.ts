import 'fake-indexeddb/auto';
import { type BikriDb, deleteTenantDb, openTenantDb } from '@bikri/db';

let n = 0;
const open: BikriDb[] = [];

/** A fresh tenant database for one test (fake-indexeddb). */
export function freshDb(prefix = 't'): BikriDb {
  n += 1;
  const db = openTenantDb(`${prefix}-${n}-${Date.now()}`);
  open.push(db);
  return db;
}

export async function dropTestDbs(): Promise<void> {
  for (const db of open.splice(0)) {
    db.close();
    await deleteTenantDb(db.tenantId);
  }
}
