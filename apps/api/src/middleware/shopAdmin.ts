/** Shop admin on admin devices (05 §3, 01 §5): admin device + owner PIN header + owner session. */
import type { MiddlewareHandler } from 'hono';
import { verifyToken } from '../auth/crypto.ts';
import { ownerSessionKey } from '../auth/ownerKeys.ts';
import { ApiError } from '../errors.ts';
import type { AppEnv } from '../types.ts';

export const OWNER_SESSION_MS = 12 * 3_600_000;
export type OwnerSession = {
  kind: 'owner';
  tenant_id: string;
  device_id: string;
  staff_id: string;
  exp: number;
};

/** Paths under /shop that need no owner session (05 §3.2). */
const NO_SESSION = [
  /\/shop\/owner-signin\/(start|verify)$/,
  /\/shop\/support-access\/end$/,
];

/** Minimal export-token shape; `routes/shop.ts` owns the full payload. */
type ExportPageToken = {
  kind: 'export';
  tenant_id: string;
  device_id: string;
  exp: number;
};

export const shopAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { device, db, tenant } = c.var;
  if (device.is_admin !== 1 || device.kind !== 'till') {
    throw new ApiError('FORBIDDEN', 403, 'Only an admin device can do this');
  }
  const path = new URL(c.req.url).pathname;
  // A signed export_id authorises its own pages and is already bound to this
  // tenant/device. Re-reading the owner row and session on every 500-row page made
  // a large export issue hundreds of extra staff queries.
  if (c.req.method === 'GET' && /\/shop\/export$/u.test(path)) {
    const exportId = c.req.query('export_id') ?? '';
    const token = exportId
      ? await verifyToken<ExportPageToken>(ownerSessionKey(c.env), exportId)
      : null;
    if (
      token?.kind === 'export' &&
      token.tenant_id === tenant.id &&
      token.device_id === device.id &&
      token.exp > Date.now()
    ) {
      await next();
      return;
    }
  }
  const staffId = c.req.header('x-bikri-staff') ?? '';
  const owner = await db.first<{ id: string }>(
    "SELECT id FROM staff WHERE tenant_id = ?1 AND id = ?2 AND role = 'owner' AND active = 1 AND deleted_at IS NULL",
    staffId,
  );
  if (!owner)
    throw new ApiError('FORBIDDEN', 403, 'Unlock as the shop owner first');
  c.set('ownerId', owner.id);
  if (!NO_SESSION.some((re) => re.test(path))) {
    const token = c.req.header('x-bikri-owner-session') ?? '';
    const s = token
      ? await verifyToken<OwnerSession>(ownerSessionKey(c.env), token)
      : null;
    if (
      s?.kind !== 'owner' ||
      s.tenant_id !== tenant.id ||
      s.device_id !== device.id ||
      s.staff_id !== owner.id ||
      s.exp <= Date.now()
    ) {
      throw new ApiError(
        'OWNER_SIGNIN_REQUIRED',
        401,
        'Confirm it’s you with the code we email',
      );
    }
  }
  await next();
};
