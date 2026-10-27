import type { TenantDb } from './db/tenantDb.ts';

export type TenantStatus =
  | 'active'
  | 'read_only'
  | 'suspended'
  | 'maintenance'
  | 'deleting'
  | 'deleted';

/** A `tenants` row (platform table). */
export type TenantRow = {
  id: string;
  slug: string;
  display_name: string;
  status: TenantStatus;
  status_reason: string;
  status_changed_at: number | null;
  status_changed_by: string | null;
  db_shard: string;
  daily_write_budget: number;
  poll_after_ms: number;
  restore_epoch: string;
  restore_point_at: number;
  change_log_floor: number;
  note: string;
  owner_email: string | null;
  last_owner_export_at: number | null;
  support_until: number | null;
  support_reason: string;
  created_by_email: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

/** A `devices` row (with token_hash: never sent to a client). */
export type DeviceRow = {
  id: string;
  name: string;
  branch_id: string;
  device_code: string;
  token_hash: string;
  is_admin: number;
  kind: 'till' | 'support';
  expires_at: number | null;
  read_only_seen_at: number | null;
  enrolled_at: number;
  enrolled_by: string;
  revoked_at: number | null;
  last_seen_at: number | null;
  last_invoice_seq: number;
  pending_ops: number;
  oldest_pending_at: number | null;
  user_agent: string | null;
  app_version: string | null;
  created_at: number;
  updated_at: number;
};

export type DeviceVars = {
  tenant: TenantRow;
  device: DeviceRow;
  db: TenantDb;
  /** Set by shopAdmin: the owner unlocked on the admin device (X-Bikri-Staff). */
  ownerId: string;
};

export type AppEnv = { Bindings: Env; Variables: DeviceVars };
