import type { MiddlewareHandler } from 'hono';
import { sha256Hex } from '../auth/crypto.ts';
import { tenantDb } from '../db/tenantDb.ts';
import { ApiError } from '../errors.ts';
import { deviceByTokenHash } from '../platform/tenants.ts';
import type { AppEnv } from '../types.ts';

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/u;
/** `last_seen_at` / pending report is written at most every 5 minutes per device (03 §6). */
const SEEN_EVERY_MS = 5 * 60_000;

/** `X-Bikri-Pending: <count>;<oldest created_at or 0>` → numbers, or null when absent/bad. */
export function parsePending(
  value: string | undefined,
): { count: number; oldest: number | null } | null {
  if (!value) return null;
  const m = /^(\d{1,7});(\d{1,15})$/u.exec(value.trim());
  if (!m) return null;
  const oldest = Number(m[2]);
  return { count: Number(m[1]), oldest: oldest > 0 ? oldest : null };
}

/**
 * Device token → device and tenant (05 §2, 13 §5). Sets `c.var.tenant`, `c.var.device` and
 * `c.var.db` (tenant-scoped). The tenant comes only from here.
 */
export const deviceAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = TOKEN.exec(c.req.header('authorization') ?? '');
  if (!m?.[1])
    throw new ApiError('UNAUTHENTICATED', 401, 'Device token required');
  const found = await deviceByTokenHash(c.env, await sha256Hex(m[1]));
  if (!found)
    throw new ApiError('UNAUTHENTICATED', 401, 'Unknown device token');
  const { device, tenant } = found;
  const now = Date.now();
  if (
    device.revoked_at !== null ||
    (device.kind === 'support' && (device.expires_at ?? 0) <= now)
  ) {
    throw new ApiError('DEVICE_REVOKED', 401, 'This device was removed');
  }
  const db = tenantDb(c.env, tenant);
  c.set('tenant', tenant);
  c.set('device', device);
  c.set('db', db);

  const pending = parsePending(c.req.header('x-bikri-pending'));
  if (now - (device.last_seen_at ?? 0) >= SEEN_EVERY_MS) {
    const app =
      (c.req.header('x-bikri-app') ?? '').slice(0, 20) || device.app_version;
    const write = db.run(
      'UPDATE devices SET last_seen_at = ?2, pending_ops = ?3, oldest_pending_at = ?4, app_version = ?5 WHERE tenant_id = ?1 AND id = ?6',
      now,
      pending?.count ?? device.pending_ops,
      pending ? pending.oldest : device.oldest_pending_at,
      app,
      device.id,
    );
    try {
      c.executionCtx.waitUntil(write.catch(() => undefined));
    } catch {
      await write.catch(() => undefined);
    }
  }
  await next();
};

/**
 * Tenant gate (13 §7.2): suspended/deleting/deleted → 403 TENANT_SUSPENDED; maintenance (tenant
 * or the whole deployment) → 503 MAINTENANCE. Active and read-only pass; writes check read-only.
 */
export const tenantGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (String(c.env.MAINTENANCE) === '1') {
    throw new ApiError(
      'MAINTENANCE',
      503,
      'Bikri is being updated',
      undefined,
      {
        'Retry-After': '300',
      },
    );
  }
  const { status } = c.var.tenant;
  if (status === 'maintenance') {
    throw new ApiError(
      'MAINTENANCE',
      503,
      'This shop is being restored',
      undefined,
      {
        'Retry-After': '300',
      },
    );
  }
  if (status !== 'active' && status !== 'read_only') {
    throw new ApiError('TENANT_SUSPENDED', 403, 'This shop is suspended');
  }
  await next();
};
