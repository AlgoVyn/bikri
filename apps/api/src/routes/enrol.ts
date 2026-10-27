import { newId } from '@bikri/core';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  codeHash,
  newDeviceToken,
  normaliseCode,
  sha256Hex,
} from '../auth/crypto.ts';
import { enrolBlocked, recordEnrolFailure } from '../auth/enrolLimit.ts';
import { tenantDb } from '../db/tenantDb.ts';
import { ApiError } from '../errors.ts';
import { enrolmentCodeByHash, getTenant } from '../platform/tenants.ts';
import { changeLogStatement } from '../sync/changeLog.ts';
import { allocateDeviceCode, publicDevice } from '../sync/devices.ts';
import { supportPayload, tenantStatusPayload } from '../sync/status.ts';
import type { AppEnv, DeviceRow } from '../types.ts';

export const EnrolBody = z.object({
  code: z.string().regex(/^[2-9A-HJKMNP-TV-Z]{4}-?[2-9A-HJKMNP-TV-Z]{4}$/i),
  user_agent: z.string().max(400),
  app_version: z.string().max(20),
});

export const SUPPORT_DEVICE_NAME = 'Algovyn support';

const badCode = () =>
  new ApiError(
    'BAD_ENROLMENT_CODE',
    400,
    'This code is not valid. Ask for a new one.',
  );

/** `POST /api/devices/enrol` (04 §3.2): the code decides the tenant and branch. */
export async function enrol(c: Context<AppEnv>): Promise<Response> {
  const now = Date.now();
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (enrolBlocked(ip, now)) {
    throw new ApiError(
      'RATE_LIMITED',
      429,
      'Too many attempts. Wait 15 minutes.',
      undefined,
      {
        'Retry-After': '900',
      },
    );
  }
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = EnrolBody.safeParse(raw);
  const normal = parsed.success ? normaliseCode(parsed.data.code) : null;
  if (!parsed.success || !normal) {
    recordEnrolFailure(ip, now);
    if (!parsed.success && !(raw && typeof raw === 'object' && 'code' in raw))
      throw parsed.error;
    throw badCode();
  }
  const hash = await codeHash(normal);
  const code = await enrolmentCodeByHash(c.env, hash);
  if (!code || code.used_at !== null || code.expires_at <= now) {
    recordEnrolFailure(ip, now);
    throw badCode();
  }
  const tenant = await getTenant(c.env, code.tenant_id);
  if (!tenant) throw badCode();
  if (tenant.status === 'maintenance') {
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
  if (tenant.status !== 'active' && tenant.status !== 'read_only') {
    throw new ApiError('TENANT_SUSPENDED', 403, 'This shop is suspended');
  }
  const support = code.kind === 'support';
  if (support && (tenant.support_until ?? 0) <= now) throw badCode();

  const db = tenantDb(c.env, tenant);
  const token = newDeviceToken();
  const device: DeviceRow = {
    id: newId(now),
    name: support ? SUPPORT_DEVICE_NAME : code.device_name,
    branch_id: code.branch_id,
    device_code: '',
    token_hash: await sha256Hex(token),
    is_admin: support ? 0 : code.grants_admin,
    kind: support ? 'support' : 'till',
    expires_at: support ? tenant.support_until : null,
    read_only_seen_at: null,
    enrolled_at: now,
    enrolled_by: code.created_by,
    revoked_at: null,
    last_seen_at: now,
    last_invoice_seq: 0,
    pending_ops: 0,
    oldest_pending_at: null,
    user_agent: parsed.data.user_agent,
    app_version: parsed.data.app_version,
    created_at: now,
    updated_at: now,
  };

  // Claim the code and create the device in one batch; the INSERT only happens if this request
  // claimed the code. A device-code race (UNIQUE) fails the whole batch: retry once.
  for (let attempt = 0; ; attempt += 1) {
    device.device_code = await allocateDeviceCode(db, device.branch_id);
    const cols = Object.keys(device);
    const insert = db.prepare(
      `INSERT INTO devices (tenant_id, ${cols.join(', ')}) SELECT ?1, ${cols.map((_, i) => `?${i + 2}`).join(', ')} WHERE EXISTS (SELECT 1 FROM enrolment_codes WHERE tenant_id = ?1 AND code_hash = ?${cols.length + 2} AND device_id = ?2)`,
      ...cols.map((k) => device[k as keyof DeviceRow]),
      hash,
    );
    try {
      const results = await db.batch([
        db.prepare(
          'UPDATE enrolment_codes SET used_at = ?2, device_id = ?3 WHERE tenant_id = ?1 AND code_hash = ?4 AND used_at IS NULL AND expires_at > ?2',
          now,
          device.id,
          hash,
        ),
        insert,
        changeLogStatement(db, 'devices', device.id, 'upsert', null, now),
      ]);
      if ((results[1]?.meta.changes ?? 0) !== 1) {
        recordEnrolFailure(ip, now);
        throw badCode();
      }
      break;
    } catch (error) {
      if (error instanceof ApiError || attempt >= 1) throw error;
    }
  }

  const shop = await db.first<{ setup_completed_at: number | null }>(
    'SELECT setup_completed_at FROM shop WHERE tenant_id = ?1',
  );
  return c.json(
    {
      tenant: { id: tenant.id, display_name: tenant.display_name },
      device: publicDevice(device),
      token,
      shop_setup_completed: Boolean(shop?.setup_completed_at),
      tenant_status: tenantStatusPayload(tenant),
      support: supportPayload(tenant, now),
      poll_after_ms: tenant.poll_after_ms,
    },
    201,
  );
}
