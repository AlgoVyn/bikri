import type { Role } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { getKv } from './kv.ts';

/** Auto-lock minutes (2–60; 0 = never, owner only). Default 10. */
export async function autoLockMinutes(db: BikriDb): Promise<number> {
  return getKv<number>(db, 'auto_lock_minutes', 10);
}

/** `0` means never only for an owner; a cashier/manager still locks after 10 minutes. */
export function effectiveAutoLockMinutes(
  configured: number,
  role: Role | 'support',
): number {
  return configured === 0 && role !== 'owner' ? 10 : configured;
}

/** Wall-clock check used on visibility/focus, where setTimeout may have been suspended. */
export function shouldAutoLock(
  configured: number,
  role: Role | 'support',
  elapsedMs: number,
): boolean {
  const minutes = effectiveAutoLockMinutes(configured, role);
  return minutes > 0 && elapsedMs >= minutes * 60_000;
}
