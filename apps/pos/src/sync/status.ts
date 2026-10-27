/** tenant_status, support and poll interval from /me, pull and push (13 §7.2, §7.5). */
import type { BikriDb } from '@bikri/db';
import { getKv, setKv } from '../data/kv.ts';

export type TenantStatusPayload = {
  status: 'active' | 'read_only';
  since: number | null;
};
export type SupportPayload = { until: number; reason: string } | null;
export type StatusPayload = {
  tenant_status?: TenantStatusPayload;
  support?: SupportPayload;
  poll_after_ms?: number;
};

export type StoredTenantStatus = TenantStatusPayload & { learned_at: number };

export async function applyStatus(
  db: BikriDb,
  p: StatusPayload,
  now = Date.now(),
): Promise<void> {
  if (p.tenant_status) {
    const prev = await getKv<StoredTenantStatus | null>(
      db,
      'tenant_status',
      null,
    );
    if (
      !prev ||
      prev.status !== p.tenant_status.status ||
      prev.since !== p.tenant_status.since
    ) {
      await setKv(db, 'tenant_status', {
        ...p.tenant_status,
        learned_at:
          prev?.status === p.tenant_status.status ? prev.learned_at : now,
      } satisfies StoredTenantStatus);
    }
  }
  if (p.support !== undefined) {
    const prev = await getKv<SupportPayload>(db, 'support', null);
    if (JSON.stringify(prev) !== JSON.stringify(p.support))
      await setKv(db, 'support', p.support);
  }
  if (typeof p.poll_after_ms === 'number') {
    const prev = await getKv<number>(db, 'poll_after_ms', 60_000);
    if (prev !== p.poll_after_ms)
      await setKv(db, 'poll_after_ms', p.poll_after_ms);
  }
}

export async function isReadOnly(db: BikriDb): Promise<boolean> {
  return (
    (await getKv<StoredTenantStatus | null>(db, 'tenant_status', null))
      ?.status === 'read_only'
  );
}
