import { can as canDo, type Permission, type Role } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDb } from '../data/db.ts';
import { useSession } from './session.ts';

export type CurrentStaff = {
  staff: MasterRow | null;
  role: Role;
  can: (permission: Permission) => boolean;
};

/**
 * The unlocked staff member. Until the PIN lock exists (T-035) a till with no session acts as
 * the shop's owner (D-090).
 */
export function useCurrentStaff(): CurrentStaff {
  const session = useSession((s) => s.session);
  const staff = useLiveQuery(async () => {
    const db = getDb();
    if (session) return (await db.staff.get(session.staff_id)) ?? null;
    const all = await db.staff.toArray();
    return (
      all.find((s) => s.role === 'owner' && s.active === 1 && !s.deleted_at) ??
      null
    );
  }, [session?.staff_id]);
  const role = (session?.role ??
    (staff?.role as Role | undefined) ??
    'owner') as Role;
  const json = String(staff?.permissions_json ?? '{}');
  return { staff: staff ?? null, role, can: (p) => canDo(role, json, p) };
}
