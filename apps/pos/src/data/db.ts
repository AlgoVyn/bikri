import { type BikriDb, openTenantDb } from '@bikri/db';
import { activeTenantId } from './tenant.ts';

let current: BikriDb | null = null;

export class NoActiveTenantError extends Error {
  constructor() {
    super('no active shop on this till; enrol first');
    this.name = 'NoActiveTenantError';
  }
}

/** The open database of the active tenant. Switching tenants closes the old one. */
export function getDb(): BikriDb {
  const tenantId = activeTenantId();
  if (!tenantId) throw new NoActiveTenantError();
  if (current && current.tenantId === tenantId) return current;
  current?.close();
  current = openTenantDb(tenantId);
  return current;
}

export function closeDb(): void {
  current?.close();
  current = null;
}
