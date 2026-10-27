/** Device enrolment and "Leave this shop" (screens/02, 05 §2, D-073). */
import { APP_VERSION } from '@bikri/core';
import { type BikriDb, deleteTenantDb, openTenantDb } from '@bikri/db';
import { request } from '../sync/client.ts';
import { applyStatus, type StatusPayload } from '../sync/status.ts';
import { closeDb } from './db.ts';
import { clearTenantFiles } from './fileCache.ts';
import type { DeviceInfo, TenantInfo } from './localTenant.ts';
import { activeTenantId, setActiveTenantId } from './tenant.ts';

export type EnrolResponse = {
  tenant: { id: string; display_name: string };
  device: {
    id: string;
    name: string;
    branch_id: string;
    device_code: string;
    is_admin: boolean;
    kind: 'till' | 'support';
    last_invoice_seq: number;
  };
  token: string;
  shop_setup_completed: boolean;
} & StatusPayload;

/** `abcd-efgh`, `ABCD EFGH` → `ABCDEFGH` (the generator never uses 0 O 1 I L U). */
export function normaliseCodeInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 8);
}

export const CODE_RE = /^[2-9A-HJKMNP-TV-Z]{8}$/;

export function formatCode(code: string): string {
  const c = normaliseCodeInput(code);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** "Chrome on Windows" from the user agent (screens/02 default device name). */
export function defaultDeviceName(
  ua = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Exchanges a code for a device token and stores everything in the new tenant database. */
export async function enrolDevice(
  code: string,
  deviceName: string,
): Promise<{ db: BikriDb; res: EnrolResponse }> {
  const res = await request<EnrolResponse>('/devices/enrol', {
    method: 'POST',
    json: {
      code: normaliseCodeInput(code),
      user_agent:
        `${deviceName} | ${typeof navigator === 'undefined' ? '' : navigator.userAgent}`.slice(
          0,
          400,
        ),
      app_version: APP_VERSION,
    },
  });
  closeDb();
  // A fresh device starts from a fresh database (a revoked device's old data was exported first).
  await deleteTenantDb(res.tenant.id);
  await clearTenantFiles(res.tenant.id);
  const db = openTenantDb(res.tenant.id);
  await db.kv.bulkPut([
    { key: 'device_token', value: res.token },
    {
      key: 'device',
      value: {
        id: res.device.id,
        name: res.device.name,
        code: res.device.device_code,
        branch_id: res.device.branch_id,
        is_admin: res.device.is_admin,
      } satisfies DeviceInfo,
    },
    { key: 'device_kind', value: res.device.kind },
    {
      key: 'tenant',
      value: {
        id: res.tenant.id,
        display_name: res.tenant.display_name,
      } satisfies TenantInfo,
    },
    { key: 'invoice_seq', value: res.device.last_invoice_seq },
    { key: 'pull_cursor', value: 0 },
    { key: 'enrolled_at', value: Date.now() },
  ]);
  await applyStatus(db, res);
  setActiveTenantId(res.tenant.id);
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best effort */
  }
  return { db, res };
}

export class UnsyncedOpsError extends Error {
  readonly count: number;
  constructor(count: number) {
    super(`${count} changes are not synced`);
    this.name = 'UnsyncedOpsError';
    this.count = count;
  }
}

/** Unsynced ops file (03 §8). */
export async function unsyncedExport(db: BikriDb, now = Date.now()) {
  const device = (await db.kv.get('device'))?.value as DeviceInfo | undefined;
  const ops = await db.outbox.orderBy('seq').toArray();
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return {
    filename: `bikri-unsynced-${device?.code ?? 'X'}-${stamp}.json`,
    data: {
      format: 'bikri-unsynced',
      version: 2,
      tenant_id: db.tenantId,
      device_id: device?.id ?? '',
      exported_at: now,
      ops: ops.map(
        ({ seq: _seq, status: _s, attempts: _a, last_error: _e, ...op }) => op,
      ),
    },
  };
}

export async function markUnsyncedExported(
  db: BikriDb,
  now = Date.now(),
): Promise<void> {
  const last = await db.outbox.orderBy('seq').last();
  await db.kv.put({
    key: 'unsynced_exported',
    value: { at: now, seq: last?.seq ?? 0 },
  });
}

/** Leave this shop: blocked while ops are unsynced unless they were exported (screens/17 This device). */
export async function unexportedOps(db: BikriDb): Promise<number> {
  const count = await db.outbox.count();
  if (count === 0) return 0;
  const exported = (await db.kv.get('unsynced_exported'))?.value as
    | { seq: number }
    | undefined;
  const last = await db.outbox.orderBy('seq').last();
  return !exported || (last?.seq ?? 0) > exported.seq ? count : 0;
}

export async function leaveShop(db: BikriDb): Promise<void> {
  const count = await unexportedOps(db);
  if (count > 0) throw new UnsyncedOpsError(count);
  const id = db.tenantId;
  db.close();
  closeDb();
  await deleteTenantDb(id);
  if (activeTenantId() === id) setActiveTenantId(null);
  await clearTenantFiles(id);
}
