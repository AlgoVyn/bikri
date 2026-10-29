/** PIN unlock and lockout (05 §4, screens/03, T-035). Everything is local; works offline. */
import { verifyPin } from '@bikri/core';
import type { BikriDb, MasterRow } from '@bikri/db';
import { getKv, setKv } from './kv.ts';

const MIN = 60_000;
export const SUPPORT_PROFILE_ID = 'support';

type Failures = Record<string, { count: number; until: number }>;

/** Lock after 5 wrong PINs → 5 min; 10 → 30 min; each further 5 doubles, capped at 1 h. */
export function lockoutMs(count: number): number {
  if (count < 5 || count % 5 !== 0) return 0;
  if (count === 5) return 5 * MIN;
  if (count === 10) return 30 * MIN;
  return Math.min(60 * MIN, 30 * MIN * 2 ** (count / 5 - 2));
}

export function triesLeft(count: number): number {
  return 5 - (count % 5);
}

export async function lockedUntil(
  db: BikriDb,
  staffId: string,
  now = Date.now(),
): Promise<number | null> {
  const f = (await getKv<Failures>(db, 'pin_failures', {}))[staffId];
  return f && f.until > now ? f.until : null;
}

export type UnlockResult =
  | { kind: 'ok'; staff: MasterRow }
  | { kind: 'wrong'; triesLeft: number }
  | { kind: 'locked'; until: number };

export async function tryUnlock(
  db: BikriDb,
  staffId: string,
  pin: string,
  now = Date.now(),
): Promise<UnlockResult> {
  const staff = await db.staff.get(staffId);
  if (staff?.active !== 1 || staff.deleted_at)
    return { kind: 'wrong', triesLeft: 0 };
  const failures = await getKv<Failures>(db, 'pin_failures', {});
  const f = failures[staffId] ?? { count: 0, until: 0 };
  if (f.until > now) return { kind: 'locked', until: f.until };
  const ok = await verifyPin(pin, {
    pin_hash: String(staff.pin_hash),
    pin_salt: String(staff.pin_salt),
    pin_iterations: Number(staff.pin_iterations),
  });
  if (ok) {
    if (failures[staffId]) {
      await db.transaction('rw', db.kv, async () => {
        const current = await getKv<Failures>(db, 'pin_failures', {});
        delete current[staffId];
        await setKv(db, 'pin_failures', current);
      });
    }
    return { kind: 'ok', staff };
  }
  // Re-read and increment inside one transaction: parallel tabs must not overwrite each other's
  // failure count and bypass the five-attempt lockout.
  const next = await db.transaction('rw', db.kv, async () => {
    const current = await getKv<Failures>(db, 'pin_failures', {});
    const latest = current[staffId] ?? { count: 0, until: 0 };
    if (latest.until > now) return latest;
    const count = latest.count + 1;
    const wait = lockoutMs(count);
    const value = { count, until: wait ? now + wait : 0 };
    current[staffId] = value;
    await setKv(db, 'pin_failures', current);
    return value;
  });
  return next.until > now
    ? { kind: 'locked', until: next.until }
    : { kind: 'wrong', triesLeft: triesLeft(next.count) };
}

const ROLE_ORDER: Record<string, number> = { owner: 0, manager: 1, cashier: 2 };

/** Active staff for the profile chips: owner → managers → cashiers, then by name. */
export async function lockProfiles(db: BikriDb): Promise<MasterRow[]> {
  return (await db.staff.toArray())
    .filter((s) => s.active === 1 && !s.deleted_at)
    .sort(
      (a, b) =>
        (ROLE_ORDER[String(a.role)] ?? 9) - (ROLE_ORDER[String(b.role)] ?? 9) ||
        String(a.name).localeCompare(String(b.name)),
    );
}

/** Auto-lock minutes (2–60; 0 = never, owner only). Default 10. */
export async function autoLockMinutes(db: BikriDb): Promise<number> {
  return getKv<number>(db, 'auto_lock_minutes', 10);
}
