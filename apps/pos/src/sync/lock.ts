/**
 * The one cross-tab lock for a shop's sync work (POS-M1). Push, pull, snapshot and
 * restore recovery all take it, so a restore that clears local tables can never run
 * while another tab has a push in flight (whose `sending` ops it would otherwise
 * treat as already queued and delete their local rows). Per tenant, so another shop
 * in the same browser is unaffected.
 */
import type { BikriDb } from '@bikri/db';

export function syncLockName(tenantId: string): string {
  return `bikri-sync-${tenantId}`;
}

export async function withSyncLock<T>(
  db: BikriDb,
  task: () => Promise<T>,
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks?.request)
    return locks.request(syncLockName(db.tenantId), task) as Promise<T>;
  return task();
}
