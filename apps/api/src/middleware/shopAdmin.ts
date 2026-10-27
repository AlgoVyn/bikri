/** Shop admin on admin devices (05 §3, 01 §5): admin device + owner PIN header + owner session. */
import type { MiddlewareHandler } from 'hono';
import { verifyToken } from '../auth/crypto.ts';
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

export const shopAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { device, db, tenant } = c.var;
  if (device.is_admin !== 1 || device.kind !== 'till') {
    throw new ApiError('FORBIDDEN', 403, 'Only an admin device can do this');
  }
  const staffId = c.req.header('x-bikri-staff') ?? '';
  const owner = await db.first<{ id: string }>(
    "SELECT id FROM staff WHERE tenant_id = ?1 AND id = ?2 AND role = 'owner' AND active = 1 AND deleted_at IS NULL",
    staffId,
  );
  if (!owner)
    throw new ApiError('FORBIDDEN', 403, 'Unlock as the shop owner first');
  c.set('ownerId', owner.id);
  const path = new URL(c.req.url).pathname;
  if (!NO_SESSION.some((re) => re.test(path))) {
    const token = c.req.header('x-bikri-owner-session') ?? '';
    const s = token
      ? await verifyToken<OwnerSession>(String(c.env.OWNER_SESSION_KEY), token)
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
