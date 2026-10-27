import { newId } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { getKv } from './kv.ts';
import { DEV_TENANT_ID } from './tenant.ts';

export type TenantInfo = { id: string; display_name: string };
export type DeviceInfo = {
  id: string;
  name: string;
  code: string;
  branch_id: string;
  is_admin: boolean;
};

export const DEV_SHOP_NAME = 'Dev Shop';

/**
 * Dev/test/e2e stand-in for what enrolment (T-034) pulls: `kv.tenant`, `kv.device` and the
 * default branch the operator's tenant creation made (D-072). Written as pulled rows, so no
 * outbox ops. Runs only for the fixed `dev` tenant and only once.
 */
export async function ensureLocalTenant(
  db: BikriDb,
  now = Date.now(),
): Promise<void> {
  if (db.tenantId !== DEV_TENANT_ID) return;
  await db.transaction('rw', [db.kv, db.branches], async () => {
    if (await db.kv.get('tenant')) return;
    const branchId = newId(now);
    await db.branches.add({
      id: branchId,
      name: 'Main',
      bill_prefix: 'A',
      address: '',
      phone: '',
      is_default: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      rev: 1,
    });
    await db.kv.bulkPut([
      {
        key: 'tenant',
        value: {
          id: DEV_TENANT_ID,
          display_name: DEV_SHOP_NAME,
        } satisfies TenantInfo,
      },
      {
        key: 'device',
        value: {
          id: newId(now),
          name: 'Counter 1',
          code: 'A',
          branch_id: branchId,
          is_admin: true,
        } satisfies DeviceInfo,
      },
    ]);
  });
}

export function tenantInfo(db: BikriDb): Promise<TenantInfo | null> {
  return getKv<TenantInfo | null>(db, 'tenant', null);
}

export function deviceInfo(db: BikriDb): Promise<DeviceInfo | null> {
  return getKv<DeviceInfo | null>(db, 'device', null);
}

/** The default branch (from tenant creation); falls back to the first live branch. */
export async function defaultBranch(db: BikriDb) {
  const all = await db.branches.toArray();
  const live = all.filter((b) => !b.deleted_at);
  return live.find((b) => b.is_default === 1) ?? live[0] ?? null;
}
