export type TenantStatus =
  | 'active'
  | 'read_only'
  | 'suspended'
  | 'maintenance'
  | 'deleting'
  | 'deleted';

export type Tenant = {
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

export type UsageToday = {
  rows_written: number;
  rows_read: number;
  pushes: number;
};

export type TenantListItem = {
  id: string;
  slug: string;
  display_name: string;
  status: TenantStatus;
  devices: number;
  last_seen_at: number | null;
  today: UsageToday;
  daily_write_budget: number;
  setup_completed: boolean;
};

export type UsageOverview = {
  email: string;
  db_size_bytes: number | null;
  today: { rows_written: number; rows_read: number };
  tenants_by_status: Record<string, number>;
  last_backup: { key: string; size: number; uploaded: number } | null;
  over_80: string[];
};

export type StatusHistoryItem = {
  from?: string;
  to?: string;
  reason?: string;
  by?: string;
  at: number;
};

export type UsageDay = {
  day: string;
  pushes: number;
  rows_written: number;
  rows_read: number;
};

export type TenantDetail = {
  tenant: Tenant;
  shop_name: string | null;
  setup_completed_at: number | null;
  devices: number;
  open_conflicts: number;
  usage: UsageDay[];
  status_history: StatusHistoryItem[];
  support: { until: number; reason: string } | null;
};

export type DeviceInfo = {
  id: string;
  name: string;
  branch_id: string;
  device_code: string;
  is_admin: boolean;
  kind: 'till' | 'support';
  expires_at: number | null;
  read_only_seen_at: number | null;
  enrolled_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
  pending_ops: number;
  app_version: string | null;
};

export type IssuedCode = {
  code: string;
  expires_at: number;
  link: string;
  support_until?: number;
};

export type OwnerProfile = {
  id: string;
  name: string;
  active: number;
};

export type BackupObject = {
  key: string;
  size: number;
  uploaded: number;
};

export type BackupManifest = {
  date?: string;
  tenants?: Record<
    string,
    {
      slug?: string;
      status?: string;
      tables?: Record<string, number>;
    }
  >;
};

export type ExportRow = Record<string, unknown>;

export type UnsyncedOp = {
  op_id: string;
  tx_id: string;
  tbl: string;
  kind: string;
  row?: Record<string, unknown>;
  row_id?: string;
  base_rev?: number;
  changed_fields?: string[];
  updated_by?: string | null;
};
