import { API_BASE } from '@bikri/core';
import type {
  BackupManifest,
  BackupObject,
  DeviceInfo,
  IssuedCode,
  OwnerProfile,
  Tenant,
  TenantDetail,
  TenantListItem,
  UnsyncedOp,
  UsageOverview,
} from './types.ts';

type ErrorBody = {
  error?: { code?: unknown; message?: unknown; details?: unknown };
};

/** Shown once, then the browser reloads into a new Cloudflare Access login. */
export const loginRedirect = {
  reload(): void {
    window.location.reload();
  },
};

export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: string,
    status: number,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AdminApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function adminErrorMessage(error: unknown, fallback: string): string {
  return error instanceof AdminApiError ? error.message : fallback;
}

function never(): Promise<never> {
  return new Promise(() => {});
}

async function readError(response: Response): Promise<AdminApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    body = null;
  }
  const code = typeof body?.error?.code === 'string' ? body.error.code : 'HTTP';
  const message =
    typeof body?.error?.message === 'string'
      ? body.error.message
      : `HTTP ${response.status}`;
  return new AdminApiError(
    code,
    response.status,
    message,
    body?.error?.details,
  );
}

type SendInit = {
  method?: string;
  body?: unknown;
};

async function send(path: string, init: SendInit = {}): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers();
  let body: string | undefined;
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.body);
  }
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body,
    credentials: 'same-origin',
    redirect: 'manual',
  });
  if (response.status === 401 || response.type === 'opaqueredirect') {
    loginRedirect.reload();
    return never();
  }
  if (!response.ok) throw await readError(response);
  return response;
}

async function apiJson<T>(path: string, init?: SendInit): Promise<T> {
  const response = await send(path, init);
  return (await response.json()) as T;
}

export function apiText(path: string): Promise<string> {
  return send(path).then((response) => response.text());
}

const idPath = (id: string, rest = '') =>
  `/admin/tenants/${encodeURIComponent(id)}${rest}`;

export function getUsage(): Promise<UsageOverview> {
  return apiJson('/admin/usage');
}

export function listTenants(): Promise<{
  tenants: TenantListItem[];
  account_today: { rows_written: number; rows_read: number };
}> {
  return apiJson('/admin/tenants');
}

export function slugAvailable(
  slug: string,
): Promise<{ slug: string; available: boolean }> {
  return apiJson(`/admin/slug-available?slug=${encodeURIComponent(slug)}`);
}

export function createTenant(body: {
  slug: string;
  display_name: string;
  owner_email?: string;
  daily_write_budget: number;
  note: string;
}): Promise<{ tenant: Tenant; owner_code: IssuedCode }> {
  return apiJson('/admin/tenants', { method: 'POST', body });
}

export function getTenant(id: string): Promise<TenantDetail> {
  return apiJson(idPath(id));
}

export function patchTenant(
  id: string,
  body: {
    display_name?: string;
    daily_write_budget?: number;
    poll_after_ms?: number;
    note?: string;
    owner_email?: string | null;
  },
): Promise<{ tenant: Tenant }> {
  return apiJson(idPath(id), { method: 'PATCH', body });
}

export function postReason(
  id: string,
  action: 'read-only' | 'suspend',
  reason: string,
): Promise<{ tenant: Tenant }> {
  return apiJson(idPath(id, `/${action}`), {
    method: 'POST',
    body: { reason },
  });
}

export function reactivateTenant(
  id: string,
  reason: string,
  to: 'active' | 'read_only',
): Promise<{ tenant: Tenant }> {
  return apiJson(idPath(id, '/reactivate'), {
    method: 'POST',
    body: { reason, to },
  });
}

export function deleteTenant(
  id: string,
  confirmSlug: string,
  reason: string,
): Promise<{ tenant: Tenant }> {
  return apiJson(idPath(id, '/delete'), {
    method: 'POST',
    body: { confirm_slug: confirmSlug, reason },
  });
}

export function startSupport(
  id: string,
  reason: string,
  hours: 1 | 2 | 4 | 8 | 24,
): Promise<IssuedCode> {
  return apiJson(idPath(id, '/support-access'), {
    method: 'POST',
    body: { reason, hours },
  });
}

export function endSupport(id: string): Promise<{ ended: boolean }> {
  return apiJson(idPath(id, '/support-access/end'), {
    method: 'POST',
    body: {},
  });
}

export function issueCode(
  id: string,
  deviceName: string,
  grantsAdmin: boolean,
): Promise<IssuedCode> {
  return apiJson(idPath(id, '/enrolment-codes'), {
    method: 'POST',
    body: { device_name: deviceName, grants_admin: grantsAdmin },
  });
}

export function listDevices(id: string): Promise<{ devices: DeviceInfo[] }> {
  return apiJson(idPath(id, '/devices'));
}

export function revokeDevice(
  id: string,
  deviceId: string,
): Promise<{ revoked_at: number }> {
  return apiJson(
    idPath(id, `/devices/${encodeURIComponent(deviceId)}/revoke`),
    { method: 'POST', body: {} },
  );
}

export function importOps(
  id: string,
  deviceId: string,
  ops: readonly UnsyncedOp[],
): Promise<{ results?: unknown[] }> {
  return apiJson(idPath(id, '/import-ops'), {
    method: 'POST',
    body: { device_id: deviceId, ops },
  });
}

export function listOwners(id: string): Promise<{ owners: OwnerProfile[] }> {
  return apiJson(idPath(id, '/owners'));
}

export function resetOwnerPin(
  id: string,
  body: {
    staff_id: string;
    pin_hash: string;
    pin_salt: string;
    pin_iterations: number;
  },
): Promise<{ ok: boolean }> {
  return apiJson(idPath(id, '/reset-owner-pin'), { method: 'POST', body });
}

export type ExportStart = {
  tenant: { id: string; slug: string; display_name: string };
  snapshot_seq: number;
  tables: { tbl: string; rows: number }[];
};

export type ExportPage = {
  tbl: string;
  rows: Record<string, unknown>[];
  next_after: string;
  has_more: boolean;
};

export function exportStart(id: string): Promise<ExportStart> {
  return apiJson(idPath(id, '/export'));
}

export function exportPage(
  id: string,
  tbl: string,
  after: string,
  limit = 1000,
): Promise<ExportPage> {
  const q = new URLSearchParams({
    tbl,
    after,
    limit: String(limit),
  });
  return apiJson(idPath(id, `/export?${q.toString()}`));
}

export function setMaintenance(
  id: string,
  on: boolean,
  reason?: string,
): Promise<{ tenant: Tenant }> {
  return apiJson(idPath(id, '/maintenance'), {
    method: 'POST',
    body: { on, ...(reason !== undefined ? { reason } : {}) },
  });
}

export function purgeTenant(
  id: string,
): Promise<{ deleted: number; remaining: number }> {
  return apiJson(idPath(id, '/purge'), { method: 'POST', body: {} });
}

export function importRows(
  id: string,
  tbl: string,
  rows: readonly Record<string, string | number | null>[],
  reason?: string,
): Promise<{ imported: number }> {
  return apiJson(idPath(id, '/import'), {
    method: 'POST',
    body: { tbl, rows, ...(reason ? { reason } : {}) },
  });
}

export function restoreEpoch(
  id: string,
  restorePointAt: number,
  reason?: string,
): Promise<{ tenant: Tenant }> {
  return apiJson(idPath(id, '/restore-epoch'), {
    method: 'POST',
    body: {
      restore_point_at: restorePointAt,
      ...(reason ? { reason } : {}),
    },
  });
}

export function listBackups(): Promise<{ objects: BackupObject[] }> {
  return apiJson('/admin/backups');
}

export async function readBackupManifest(
  key: string,
): Promise<BackupManifest | null> {
  try {
    const text = await apiText(
      `/admin/backups/download?key=${encodeURIComponent(key)}`,
    );
    return JSON.parse(text) as BackupManifest;
  } catch {
    return null;
  }
}
