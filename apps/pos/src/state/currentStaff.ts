import { can as canDo, type Permission, type Role } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect } from 'react';
import { getDb } from '../data/db.ts';
import { useSession } from './session.ts';

export type CurrentStaff = {
  staff: MasterRow | null;
  role: Role;
  can: (permission: Permission) => boolean;
  /** The view-only Algovyn support profile (13 §7.5). */
  support: boolean;
};

/** What the support profile may do: look, never write. */
const SUPPORT_ALLOWED: ReadonlySet<Permission> = new Set([
  'report.view',
  'cost.view',
  'dayclose.view_expected',
  'export.data',
  'settings.device',
  'settings.shop',
  'devices.manage',
]);

/**
 * The unlocked staff member. Until the PIN lock exists (T-035) a till with no session acts as
 * the shop's owner (D-090).
 */
export function useCurrentStaff(): CurrentStaff {
  const session = useSession((s) => s.session);
  const localTenant =
    import.meta.env.DEV || import.meta.env.VITE_LOCAL_TENANT === 'dev';
  const staff = useLiveQuery(async () => {
    const db = getDb();
    if (session?.role === 'support') return null;
    if (session) return (await db.staff.get(session.staff_id)) ?? null;
    // The dev/e2e shop has no PIN session; production must never act as owner
    // without an unlocked staff member.
    if (!localTenant) return null;
    const all = await db.staff.toArray();
    return (
      all.find((s) => s.role === 'owner' && s.active === 1 && !s.deleted_at) ??
      null
    );
  }, [session?.staff_id, localTenant]);
  const live = staff && staff.active === 1 && !staff.deleted_at ? staff : null;
  const loaded = staff !== undefined;
  useEffect(() => {
    if (session?.role === 'support' || !session || !loaded) return;
    // Wait until the live query has caught up with the newly unlocked profile; otherwise the
    // previous owner row can briefly look like a role change and lock the till immediately.
    if (live && live.id !== session.staff_id) return;
    // A revoked/deleted profile, or a role changed on another till, must not keep the old
    // permissions in memory (the server enforces the same rules, but the UI should not offer them).
    if (!live || live.role !== session.role) useSession.getState().lock();
  }, [session, loaded, live]);
  if (session?.role === 'support')
    return {
      staff: null,
      role: 'cashier',
      can: (p) => SUPPORT_ALLOWED.has(p),
      support: true,
    };
  const role = (live?.role ??
    (loaded ? 'cashier' : (session?.role ?? 'owner'))) as Role;
  const json = String(live?.permissions_json ?? '{}');
  return {
    staff: live,
    role,
    can: (p) => canDo(role, json, p),
    support: false,
  };
}
