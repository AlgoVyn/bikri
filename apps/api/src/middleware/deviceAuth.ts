import { API_BASE } from '@bikri/core';
import type { MiddlewareHandler } from 'hono';
import { sha256Hex } from '../auth/crypto.ts';
import { tenantDb } from '../db/tenantDb.ts';
import { ApiError } from '../errors.ts';
import { deviceByTokenHash } from '../platform/tenants.ts';
import type { AppEnv } from '../types.ts';

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/u;
/** `last_seen_at` / pending report is written at most every 5 minutes per device (03 §6). */
const SEEN_EVERY_MS = 15 * 60_000;

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
  const now = Date.now();
  const found = await deviceByTokenHash(c.env, await sha256Hex(m[1]), now);
  if (!found)
    throw new ApiError('UNAUTHENTICATED', 401, 'Unknown device token');
  const { device, tenant, usage } = found;
  if (
    device.revoked_at !== null ||
    (device.kind === 'support' &&
      ((device.expires_at ?? 0) <= now || (tenant.support_until ?? 0) <= now))
  ) {
    throw new ApiError('DEVICE_REVOKED', 401, 'This device was removed');
  }
  const db = tenantDb(c.env, tenant);
  c.set('tenant', tenant);
  c.set('device', device);
  c.set('db', db);
  c.set('usage', usage);
  // The till "knows" server changes only up to its last completed download. Push and /me
  // must not advance this, or an offline backlog pushed before the first pull would be
  // validated as if the till had already seen every remote price/cost change (API-M5).
  c.set('deviceSeenAt', Number(device.last_seen_at ?? 0));
  // Photos/logos are content-addressed and cached by the file route; a global
  // no-store here used to override its immutable header (D-231).
  if (!(c.req.method === 'GET' && c.req.path.startsWith(`${API_BASE}/files/`)))
    c.header('Cache-Control', 'private, no-store');

  // A suspended/deleting shop or deployment-wide maintenance is refused by `tenantGate`.
  // Do not spend a write (and a daily row) on `last_seen_at` for a request that cannot
  // read anything (API-L4).
  const gateAllows =
    String(c.env.MAINTENANCE) !== '1' &&
    (tenant.status === 'active' || tenant.status === 'read_only');
  const pending = parsePending(c.req.header('x-bikri-pending'));
  // `last_seen_at` means "last successful download" for freshness checks: only pull and
  // snapshot advance it. Other requests still record the pending backlog/app version.
  const advancesSeen =
    c.req.path === `${API_BASE}/sync/pull` ||
    c.req.path === `${API_BASE}/sync/snapshot`;
  if (gateAllows && now - (device.last_seen_at ?? 0) >= SEEN_EVERY_MS) {
    const app =
      (c.req.header('x-bikri-app') ?? '').slice(0, 20) || device.app_version;
    const write = db.run(
      'UPDATE devices SET last_seen_at = CASE WHEN ?7 = 1 THEN ?2 ELSE last_seen_at END, pending_ops = ?3, oldest_pending_at = ?4, app_version = ?5 WHERE tenant_id = ?1 AND id = ?6',
      now,
      pending?.count ?? device.pending_ops,
      pending ? pending.oldest : device.oldest_pending_at,
      app,
      device.id,
      advancesSeen ? 1 : 0,
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
