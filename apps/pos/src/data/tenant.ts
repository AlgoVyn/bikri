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

/**
 * The tab's own view of the active shop. A shared tablet must not mix shops
 * (D-073), so a switch in one tab closes the shop view in the others instead of
 * letting them keep writing into the newly active database.
 */
let tabTenant: string | null | undefined;
let channel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined')
    channel = new BroadcastChannel('bikri-tenant');
} catch {
  // Private modes can refuse BroadcastChannel; the storage event still covers switches.
}

function readStoredTenant(): string | null {
  return storage()?.getItem(ACTIVE_TENANT_KEY) ?? null;
}

/** The tenant whose database the app opens, or null when the till must enrol first. */
export function activeTenantId(
  env: Env = import.meta.env as Env,
): string | null {
  if (tabTenant === undefined) tabTenant = readStoredTenant();
  if (tabTenant) return tabTenant;
  return usesDevTenant(env) ? DEV_TENANT_ID : null;
}

export function setActiveTenantId(tenantId: string | null): void {
  tabTenant = tenantId;
  const s = storage();
  if (s) {
    if (tenantId === null) s.removeItem(ACTIVE_TENANT_KEY);
    else s.setItem(ACTIVE_TENANT_KEY, tenantId);
  }
  channel?.postMessage({ tenantId });
}

/**
 * Reacts to a shop switch made in another tab. Reloading boots the app against the
 * new shop; keeping the old screen would let it write the old shop's rows into the
 * new database. Exported for the tab-isolation test.
 */
export function handleOtherTabSwitch(
  next: string | null,
  reload: () => void = () => {
    if (
      typeof window !== 'undefined' &&
      typeof window.location?.reload === 'function'
    )
      window.location.reload();
  },
): void {
  if (next === tabTenant) return;
  reload();
}

channel?.addEventListener('message', (event: MessageEvent) => {
  const next =
    event.data !== null && typeof event.data === 'object'
      ? ((event.data as { tenantId?: unknown }).tenantId ?? null)
      : null;
  handleOtherTabSwitch(typeof next === 'string' ? next : null);
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== ACTIVE_TENANT_KEY) return;
    handleOtherTabSwitch(event.newValue);
  });
}
