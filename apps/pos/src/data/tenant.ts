/** Active tenant on this till (D-073). One Dexie database per tenant: `bikri-<tenant_id>`. */
export const ACTIVE_TENANT_KEY = 'bikri.active_tenant';
/** Fixed tenant for dev, test and e2e builds; production builds enrol first (T-034). */
export const DEV_TENANT_ID = 'dev';

type Env = { DEV?: boolean; MODE?: string; VITE_LOCAL_TENANT?: string };

export function usesDevTenant(env: Env = import.meta.env as Env): boolean {
  return (
    Boolean(env.DEV) ||
    env.MODE === 'test' ||
    env.VITE_LOCAL_TENANT === DEV_TENANT_ID
  );
}

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** The tenant whose database the app opens, or null when the till must enrol first. */
export function activeTenantId(
  env: Env = import.meta.env as Env,
): string | null {
  const stored = storage()?.getItem(ACTIVE_TENANT_KEY);
  if (stored) return stored;
  return usesDevTenant(env) ? DEV_TENANT_ID : null;
}

export function setActiveTenantId(tenantId: string | null): void {
  const s = storage();
  if (!s) return;
  if (tenantId === null) s.removeItem(ACTIVE_TENANT_KEY);
  else s.setItem(ACTIVE_TENANT_KEY, tenantId);
}
