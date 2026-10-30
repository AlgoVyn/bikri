/** Shop-admin endpoints on admin devices (04 §3.8) and owner email sign-in (05 §3.2). */
import { newId } from '@bikri/core';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import {
  codeHash,
  hmacHex,
  newSixDigitCode,
  normaliseCode,
  safeEqual,
  signToken,
  verifyToken,
} from '../auth/crypto.ts';
import { sendSigninEmail } from '../auth/mailer.ts';
import { ownerCodeKey, ownerSessionKey } from '../auth/ownerKeys.ts';
import type { TenantDb } from '../db/tenantDb.ts';
import { ApiError } from '../errors.ts';
import {
  OWNER_SESSION_MS,
  type OwnerSession,
} from '../middleware/shopAdmin.ts';
import {
  enrolLink,
  enrolmentCodeStatement,
  TILL_CODE_TTL_MS,
} from '../platform/createTenant.ts';
import {
  maskEmail,
  ownerExportStatement,
  supportStatement,
} from '../platform/tenantAdmin.ts';
import { auditStatements } from '../sync/audit.ts';
import { changeLogStatement } from '../sync/changeLog.ts';
import { allocateDeviceCode } from '../sync/devices.ts';
import { importOps } from '../sync/importOps.ts';
import { ImportOpsBody } from '../sync/opSchema.ts';
import { revokeSupportDevices } from '../sync/status.ts';
import type { AppEnv, DeviceRow, TenantRow } from '../types.ts';
import { snapshotPayload } from './sync.ts';

export const shop = new Hono<AppEnv>();

const MIN = 60_000;
const HOUR = 3_600_000;
export const SIGNIN = {
  ttl: 10 * MIN,
  tries: 5,
  cooldown: MIN,
  perHour: 5,
  perDay: 20,
  deadPerHour: 3,
  pause: HOUR,
} as const;
const EXPORT_TTL = 2 * HOUR;
const EXPORT_EVERY = 24 * HOUR;

function rateLimited(message: string, seconds: number): ApiError {
  const s = Math.max(1, Math.ceil(seconds));
  return new ApiError(
    'RATE_LIMITED',
    429,
    message,
    { retry_after: s },
    { 'Retry-After': String(s) },
  );
}

function readOnly(tenant: TenantRow): void {
  if (tenant.status === 'read_only') {
    throw new ApiError('TENANT_READ_ONLY', 403, 'This shop is read-only', {
      since: tenant.status_changed_at,
    });
  }
}

async function ipLimit(c: Context<AppEnv>): Promise<void> {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const limiter = c.env.OWNER_SIGNIN_LIMIT;
  if (!limiter) return;
  const { success } = await limiter.limit({ key: `ip:${ip}` });
  if (!success) throw rateLimited('Too many tries. Wait a minute.', 60);
}

const audit = (
  c: Context<AppEnv>,
  action: string,
  extra: Partial<Parameters<typeof auditStatements>[1]> = {},
) =>
  auditStatements(c.var.db, {
    action,
    deviceId: c.var.device.id,
    staffId: c.var.ownerId,
    now: Date.now(),
    ...extra,
  });

// ---- owner email sign-in ----------------------------------------------------------------------

shop.post('/owner-signin/start', async (c) => {
  const { tenant, device, db, ownerId } = c.var;
  await ipLimit(c);
  const now = Date.now();
  if (!tenant.owner_email)
    throw new ApiError(
      'OWNER_EMAIL_MISSING',
      503,
      'No owner email is set for this shop',
    );
  const [recent, shopRow] = await db.batch([
    db.prepare(
      'SELECT device_id, created_at, attempts, used_at, expires_at FROM owner_email_codes WHERE tenant_id = ?1 AND created_at > ?2 ORDER BY created_at DESC',
      now - 24 * HOUR,
    ),
    db.prepare('SELECT name FROM shop WHERE tenant_id = ?1'),
  ]);
  const rows = (recent?.results ?? []) as {
    device_id: string;
    created_at: number;
    attempts: number;
    used_at: number | null;
    expires_at: number;
  }[];
  const mine = rows.find((r) => r.device_id === device.id);
  if (mine && now - mine.created_at < SIGNIN.cooldown) {
    throw rateLimited(
      'Wait a minute before asking for another code',
      (SIGNIN.cooldown - (now - mine.created_at)) / 1000,
    );
  }
  const hour = rows.filter((r) => now - r.created_at < HOUR);
  const dead = hour.filter(
    (r) => r.attempts >= SIGNIN.tries && r.used_at === null,
  );
  if (dead.length >= SIGNIN.deadPerHour) {
    const third = dead[SIGNIN.deadPerHour - 1]?.created_at ?? now;
    throw rateLimited(
      'Sign-in is paused for an hour',
      (third + SIGNIN.pause - now) / 1000,
    );
  }
  if (hour.length >= SIGNIN.perHour) {
    const oldest = hour.at(-1)?.created_at ?? now;
    throw rateLimited('Too many codes this hour', (oldest + HOUR - now) / 1000);
  }
  if (rows.length >= SIGNIN.perDay) {
    const oldest = rows.at(-1)?.created_at ?? now;
    throw rateLimited(
      'Too many codes today',
      (oldest + 24 * HOUR - now) / 1000,
    );
  }
  const id = newId(now);
  const code = newSixDigitCode();
  const hash = await hmacHex(ownerCodeKey(c.env), `${tenant.id}${id}${code}`);
  const expires = now + SIGNIN.ttl;
  await db.batch([
    // A new code ends the previous unused one (expired, not dead: it does not count toward the pause).
    db.prepare(
      'UPDATE owner_email_codes SET expires_at = ?2 WHERE tenant_id = ?1 AND used_at IS NULL AND expires_at > ?2',
      now,
    ),
    db.prepare(
      'INSERT INTO owner_email_codes (tenant_id, id, device_id, staff_id, code_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      id,
      device.id,
      ownerId,
      hash,
      now,
      expires,
    ),
  ]);
  const shopName = String(
    (shopRow?.results?.[0] as { name?: string } | undefined)?.name ??
      tenant.display_name,
  );
  await sendSigninEmail(c.env, tenant.owner_email, {
    code,
    shopName,
    deviceName: device.name,
  });
  return c.json({
    code_id: id,
    expires_at: expires,
    email_hint: maskEmail(tenant.owner_email),
  });
});

shop.post('/owner-signin/verify', async (c) => {
  const { tenant, device, db, ownerId } = c.var;
  await ipLimit(c);
  const body = z
    .object({ code_id: z.string().max(40), code: z.string().regex(/^\d{6}$/) })
    .parse(await c.req.json());
  const now = Date.now();
  const bad = (left: number) =>
    new ApiError('BAD_SIGNIN_CODE', 400, 'That code is not right', {
      tries_left: Math.max(0, left),
    });
  const row = await db.first<{
    code_hash: string;
    attempts: number;
    expires_at: number;
    used_at: number | null;
    staff_id: string;
  }>(
    'SELECT code_hash, attempts, expires_at, used_at, staff_id FROM owner_email_codes WHERE tenant_id = ?1 AND id = ?2 AND device_id = ?3',
    body.code_id,
    device.id,
  );
  if (
    !row ||
    row.used_at !== null ||
    row.expires_at <= now ||
    row.attempts >= SIGNIN.tries ||
    row.staff_id !== ownerId
  ) {
    throw bad(0);
  }
  const hash = await hmacHex(
    ownerCodeKey(c.env),
    `${tenant.id}${body.code_id}${body.code}`,
  );
  if (!safeEqual(hash, row.code_hash)) {
    await db.run(
      'UPDATE owner_email_codes SET attempts = attempts + 1 WHERE tenant_id = ?1 AND id = ?2 AND attempts < 5',
      body.code_id,
    );
    console.log(JSON.stringify({ event: 'owner_signin_wrong_code' }));
    throw bad(SIGNIN.tries - row.attempts - 1);
  }
  const res = await db.batch([
    db.prepare(
      'UPDATE owner_email_codes SET used_at = ?3 WHERE tenant_id = ?1 AND id = ?2 AND used_at IS NULL AND attempts < 5',
      body.code_id,
      now,
    ),
  ]);
  if ((res[0]?.meta.changes ?? 0) !== 1) throw bad(0);
  await db.batch(
    audit(c, 'owner_signin', { entity: 'staff', entityId: ownerId }),
  );
  const exp = now + OWNER_SESSION_MS;
  const session = await signToken(ownerSessionKey(c.env), {
    kind: 'owner',
    tenant_id: tenant.id,
    device_id: device.id,
    staff_id: ownerId,
    exp,
  } satisfies OwnerSession);
  return c.json({ session, expires_at: exp });
});

// ---- support access ---------------------------------------------------------------------------

shop.post('/support-access/end', async (c) => {
  const { tenant, db } = c.var;
  const now = Date.now();
  if (tenant.support_until === null || tenant.support_until <= now)
    return c.json({ ended: false });
  await db.batch([
    supportStatement(c.env, tenant.id, now, tenant.support_reason, now),
    db.prepare(
      "DELETE FROM enrolment_codes WHERE tenant_id = ?1 AND kind = 'support' AND used_at IS NULL",
    ),
    ...(await revokeSupportDevices(db, now)),
    ...audit(c, 'support_access_end', { after: { ended_by: 'owner' } }),
  ]);
  return c.json({ ended: true });
});

// ---- enrolment codes --------------------------------------------------------------------------

async function branchExists(db: TenantDb, id: string): Promise<boolean> {
  return (
    (await db.first(
      'SELECT id FROM branches WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL',
      id,
    )) !== null
  );
}

shop.post('/enrolment-codes', async (c) => {
  const { tenant, db, device } = c.var;
  const body = z
    .object({
      device_name: z.string().trim().min(1).max(40),
      branch_id: z.string().max(40),
      is_admin: z.boolean().default(false),
    })
    .parse(await c.req.json());
  if (!(await branchExists(db, body.branch_id)))
    throw new ApiError('NOT_FOUND', 404, 'No such branch');
  const now = Date.now();
  const code = await enrolmentCodeStatement(c.env, tenant.id, {
    device_name: body.device_name,
    branch_id: body.branch_id,
    grants_admin: body.is_admin,
    created_by: `device:${device.id}`,
    now,
    ttl_ms: TILL_CODE_TTL_MS,
  });
  await db.batch([
    code.statement,
    ...audit(c, 'device_enrol_code', {
      after: { device_name: body.device_name, is_admin: body.is_admin },
    }),
  ]);
  return c.json(
    {
      code: code.code,
      expires_at: code.expires_at,
      link: enrolLink(
        new URL(c.req.url).origin,
        String(c.env.BASE_PATH),
        code.code,
      ),
    },
    201,
  );
});

shop.get('/enrolment-codes', async (c) => {
  const rows = await c.var.db.select<{
    code_hash: string;
    device_name: string;
    grants_admin: number;
    expires_at: number;
    created_at: number;
  }>(
    "SELECT code_hash, device_name, grants_admin, expires_at, created_at FROM enrolment_codes WHERE tenant_id = ?1 AND used_at IS NULL AND expires_at > ?2 AND kind = 'till' ORDER BY created_at",
    Date.now(),
  );
  return c.json({
    codes: rows.map((r) => ({
      id: r.code_hash.slice(0, 16),
      device_name: r.device_name,
      is_admin: r.grants_admin === 1,
      expires_at: r.expires_at,
      created_at: r.created_at,
    })),
  });
});

/** Cancel by the plain code (kept in memory by the page) or by the list id (D-105). */
shop.delete('/enrolment-codes/:code', async (c) => {
  const { db } = c.var;
  const raw = c.req.param('code');
  const plain = normaliseCode(raw);
  const res = plain
    ? await db.run(
        "DELETE FROM enrolment_codes WHERE tenant_id = ?1 AND code_hash = ?2 AND used_at IS NULL AND kind = 'till'",
        await codeHash(plain),
      )
    : /^[0-9a-f]{16}$/.test(raw)
      ? await db.run(
          "DELETE FROM enrolment_codes WHERE tenant_id = ?1 AND substr(code_hash, 1, 16) = ?2 AND used_at IS NULL AND kind = 'till'",
          raw,
        )
      : null;
  if (!res || (res.meta.changes ?? 0) === 0)
    throw new ApiError('NOT_FOUND', 404, 'No such code');
  return c.body(null, 204);
});

// ---- devices ----------------------------------------------------------------------------------

const shopDevice = (d: DeviceRow) => ({
  id: d.id,
  name: d.name,
  branch_id: d.branch_id,
  device_code: d.device_code,
  is_admin: d.is_admin === 1,
  kind: d.kind,
  enrolled_at: d.enrolled_at,
  last_seen_at: d.last_seen_at,
  app_version: d.app_version,
  pending_ops: d.pending_ops,
  oldest_pending_at: d.oldest_pending_at,
  revoked_at: d.revoked_at,
  expires_at: d.expires_at,
});

shop.get('/devices', async (c) => {
  const rows = await c.var.db.select<DeviceRow>(
    'SELECT * FROM devices WHERE tenant_id = ?1 ORDER BY revoked_at IS NOT NULL, enrolled_at',
  );
  return c.json({ devices: rows.map(shopDevice) });
});

async function deviceOf(db: TenantDb, id: string): Promise<DeviceRow> {
  const d = await db.first<DeviceRow>(
    'SELECT * FROM devices WHERE tenant_id = ?1 AND id = ?2',
    id,
  );
  if (!d) throw new ApiError('NOT_FOUND', 404, 'No such device in this shop');
  return d;
}

async function otherAdmins(db: TenantDb, id: string): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?1 AND id <> ?2 AND is_admin = 1 AND kind = 'till' AND revoked_at IS NULL",
    id,
  );
  return r?.n ?? 0;
}

shop.patch('/devices/:id', async (c) => {
  const { db } = c.var;
  const body = z
    .object({
      name: z.string().trim().min(1).max(40).optional(),
      branch_id: z.string().max(40).optional(),
      is_admin: z.boolean().optional(),
    })
    .strict()
    .parse(await c.req.json());
  const d = await deviceOf(db, c.req.param('id'));
  if (d.revoked_at !== null)
    throw new ApiError('CONFLICT', 409, 'This device is revoked');
  if (body.is_admin === true && d.kind !== 'till')
    throw new ApiError('FORBIDDEN', 403, 'Support devices are never admin');
  if (
    body.is_admin === false &&
    d.is_admin === 1 &&
    (await otherAdmins(db, d.id)) === 0
  ) {
    throw new ApiError(
      'LAST_ADMIN_DEVICE',
      409,
      'Keep at least one admin device',
    );
  }
  const next = { ...d };
  if (body.name !== undefined) next.name = body.name;
  if (body.is_admin !== undefined) next.is_admin = body.is_admin ? 1 : 0;
  if (body.branch_id !== undefined && body.branch_id !== d.branch_id) {
    if (!(await branchExists(db, body.branch_id)))
      throw new ApiError('NOT_FOUND', 404, 'No such branch');
    next.branch_id = body.branch_id;
    next.device_code = await allocateDeviceCode(db, body.branch_id);
  }
  const now = Date.now();
  const adminGuard =
    body.is_admin === false && d.is_admin === 1
      ? " AND (SELECT COUNT(*) FROM devices WHERE tenant_id = ?1 AND id <> ?2 AND is_admin = 1 AND kind = 'till' AND revoked_at IS NULL) > 0"
      : '';
  const update = db.prepare(
    `UPDATE devices SET name = ?3, branch_id = ?4, device_code = ?5, is_admin = ?6, updated_at = ?7 WHERE tenant_id = ?1 AND id = ?2${adminGuard}`,
    d.id,
    next.name,
    next.branch_id,
    next.device_code,
    next.is_admin,
    now,
  );
  const res = await db.batch([update]);
  if ((res[0]?.meta.changes ?? 0) !== 1)
    throw new ApiError(
      'CONFLICT',
      409,
      'This device changed elsewhere; refresh and try again',
    );
  await db.batch([
    changeLogStatement(db, 'devices', d.id, 'upsert', null, now),
    ...audit(c, 'device_change', {
      entity: 'devices',
      entityId: d.id,
      before: {
        name: d.name,
        branch_id: d.branch_id,
        device_code: d.device_code,
        is_admin: d.is_admin === 1,
      },
      after: {
        name: next.name,
        branch_id: next.branch_id,
        device_code: next.device_code,
        is_admin: next.is_admin === 1,
      },
    }),
  ]);
  return c.json({ device: shopDevice({ ...next, updated_at: now }) });
});

shop.post('/devices/:id/revoke', async (c) => {
  const { db } = c.var;
  const d = await deviceOf(db, c.req.param('id'));
  if (d.revoked_at !== null) return c.json({ revoked_at: d.revoked_at });
  if (d.is_admin === 1 && (await otherAdmins(db, d.id)) === 0) {
    throw new ApiError(
      'LAST_ADMIN_DEVICE',
      409,
      'The last admin device can only be revoked by Algovyn',
    );
  }
  const now = Date.now();
  const update = db.prepare(
    "UPDATE devices SET revoked_at = ?2, updated_at = ?2 WHERE tenant_id = ?1 AND id = ?3 AND (is_admin = 0 OR (SELECT COUNT(*) FROM devices WHERE tenant_id = ?1 AND id <> ?3 AND is_admin = 1 AND kind = 'till' AND revoked_at IS NULL) > 0)",
    now,
    d.id,
  );
  const res = await db.batch([update]);
  if ((res[0]?.meta.changes ?? 0) !== 1)
    throw new ApiError(
      'LAST_ADMIN_DEVICE',
      409,
      'Keep at least one admin device',
    );
  await db.batch([
    changeLogStatement(db, 'devices', d.id, 'upsert', null, now),
    ...audit(c, 'device_revoke', {
      entity: 'devices',
      entityId: d.id,
      after: { name: d.name },
    }),
  ]);
  return c.json({ revoked_at: now });
});

shop.post('/import-ops', async (c) => {
  const { tenant, db } = c.var;
  // importOps applies only transactions created before a read-only cutoff (13 §7.2).
  const body = ImportOpsBody.parse(await c.req.json());
  const now = Date.now();
  const out = await importOps(c.env, db, tenant, body.device_id, body.ops, now);
  await db.batch(
    audit(c, 'ops_import', {
      entity: 'devices',
      entityId: body.device_id,
      after: { ops: body.ops.length, applied: out.results.length },
    }),
  );
  return c.json(out);
});

shop.post('/conflicts/:id/acknowledge', async (c) => {
  const { tenant, db } = c.var;
  readOnly(tenant);
  const id = c.req.param('id');
  const now = Date.now();
  const res = await db.batch([
    db.prepare(
      "UPDATE sync_conflicts SET resolution = 'acknowledged' WHERE tenant_id = ?1 AND id = ?2 AND resolution = 'needs_owner'",
      id,
    ),
    changeLogStatement(db, 'sync_conflicts', id, 'upsert', null, now),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0) {
    const exists = await db.first(
      'SELECT id FROM sync_conflicts WHERE tenant_id = ?1 AND id = ?2',
      id,
    );
    if (!exists) throw new ApiError('NOT_FOUND', 404, 'No such conflict');
  }
  return c.json({ ok: true });
});

// ---- owner server export (13 §7.3) ------------------------------------------------------------

type ExportToken = {
  kind: 'export';
  tenant_id: string;
  device_id: string;
  exp: number;
};

shop.get('/export', async (c) => {
  const { tenant, device, db } = c.var;
  const now = Date.now();
  const exportId = c.req.query('export_id');
  if (!exportId) {
    if (
      tenant.last_owner_export_at !== null &&
      now - tenant.last_owner_export_at < EXPORT_EVERY
    ) {
      throw rateLimited(
        'One server export per day',
        (tenant.last_owner_export_at + EXPORT_EVERY - now) / 1000,
      );
    }
    const start = await snapshotPayload(() => undefined, db, tenant, 500);
    const token = await signToken(ownerSessionKey(c.env), {
      kind: 'export',
      tenant_id: tenant.id,
      device_id: device.id,
      exp: now + EXPORT_TTL,
    } satisfies ExportToken);
    await db.batch([
      ownerExportStatement(c.env, tenant.id, now),
      ...audit(c, 'owner_export'),
    ]);
    return c.json({ export_id: token, ...start });
  }
  const t = await verifyToken<ExportToken>(ownerSessionKey(c.env), exportId);
  if (
    t?.kind !== 'export' ||
    t.tenant_id !== tenant.id ||
    t.device_id !== device.id ||
    t.exp <= now
  ) {
    throw new ApiError(
      'VALIDATION_FAILED',
      400,
      'This export has expired; start a new one',
    );
  }
  if (!c.req.query('tbl'))
    throw new ApiError('VALIDATION_FAILED', 400, 'tbl is required');
  return c.json(await snapshotPayload((k) => c.req.query(k), db, tenant, 500));
});
