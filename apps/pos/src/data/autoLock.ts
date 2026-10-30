import type { BikriDb } from '@bikri/db';
import { getKv } from './kv.ts';

/** Auto-lock minutes (2–60; 0 = never, owner only). Default 10. */
export async function autoLockMinutes(db: BikriDb): Promise<number> {
  return getKv<number>(db, 'auto_lock_minutes', 10);
}
