/** Operator endpoints behind Cloudflare Access (04 §3.7, screens/19). */
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { type TenantDb, tenantDb } from '../db/tenantDb.ts';
import { ApiError } from '../errors.ts';
import type { OperatorVars } from '../middleware/accessAuth.ts';
import {
  createTenant,
  enrolLink,
  enrolmentCodeStatement,
  OWNER_CODE_TTL_MS,
  SlugTakenError,
  TILL_CODE_TTL_MS,
} from '../platform/createTenant.ts';
import {
  accountOverview,
  listTenants,
  maskEmail,
  patchTenantStatement,
  restoreEpochStatement,
  statusChangeAllowed,
  statusChangeStatements,
  supportStatement,
  tenantById,
  tenantBySlug,
  usageHistory,
} from '../platform/tenantAdmin.ts';
import { auditStatements } from '../sync/audit.ts';
import { changeLogStatement } from '../sync/changeLog.ts';
import { importOps } from '../sync/importOps.ts';
import { ImportOpsBody } from '../sync/opSchema.ts';
import { revokeSupportDevices, supportPayload } from '../sync/status.ts';
import { APPLY_ORDER, clientColumns, SNAPSHOT_TABLES } from '../sync/tables.ts';
import type { DeviceRow, TenantRow, TenantStatus } from '../types.ts';
import { snapshotPayload } from './sync.ts';

type AdminEnv = {
  Bindings: Env;
  Variables: OperatorVars & { tenant: TenantRow; db: TenantDb };
};

export const admin = new Hono<AdminEnv>();

const Reason = z.string().trim().min(1).max(200);
const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
const Slug = z.string().regex(/^[a-z0-9-]{3,30}$/);
const BUDGET = z.number().int().min(0).max(100_000);
const PURGE_CHUNK = 5_000;

const by = (email: string) => `operator:${email}`;
const origin = (c: { req: { url: string } }) => new URL(c.req.url).origin;
const issued = (
  env: Env,
  c: { req: { url: string } },
  code: string,
  expires_at: number,
) => ({
  code,
  expires_at,
  link: enrolLink(origin(c), String(env.BASE_PATH), code),
});

admin.get('/session', (c) => c.json({ email: c.var.operator }));

admin.get('/usage', async (c) => {
  const now = Date.now();
  const [overview, list, backups] = await Promise.all([
    accountOverview(c.env, now),
    listTenants(c.env, now),
    c.env.BACKUPS.list({ prefix: 'd1/', limit: 1000 }),
  ]);
  const last = backups.objects.sort(
    (a, b) => b.uploaded.getTime() - a.uploaded.getTime(),
  )[0];
  return c.json({
    email: c.var.operator,
    ...overview,
    last_backup: last
      ? { key: last.key, size: last.size, uploaded: last.uploaded.getTime() }
      : null,
    over_80: list.tenants
      .filter(
        (t) =>
          t.daily_write_budget > 0 &&
          t.today.rows_written >= 0.8 * t.daily_write_budget,
      )
      .map((t) => t.id),
  });
});

admin.get('/tenants', async (c) =>
  c.json(await listTenants(c.env, Date.now())),
);

admin.post('/tenants', async (c) => {
  const body = z
    .object({
      slug: Slug,
      display_name: z.string().trim().min(1).max(60),
      owner_email: Email.nullish(),
      daily_write_budget: BUDGET.default(18_000),
      note: z.string().max(500).default(''),
    })
    .parse(await c.req.json());
  try {
    const { tenant, owner_code } = await createTenant(c.env, {
      ...body,
      owner_email: body.owner_email ?? null,
      created_by_email: c.var.operator,
    });
    return c.json(
      {
        tenant,
        owner_code: issued(c.env, c, owner_code.code, owner_code.expires_at),
      },
      201,
    );
  } catch (e) {
    if (e instanceof SlugTakenError)
      throw new ApiError('SLUG_TAKEN', 409, 'That slug is taken');
    throw e;
  }
});

admin.get('/slug-available', async (c) => {
  const slug = Slug.parse(c.req.query('slug'));
  return c.json({
    slug,
    available: (await tenantBySlug(c.env, slug)) === null,
  });
});

// ---- per-tenant routes -------------------------------------------------------------------------

const loadTenant: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const tenant = await tenantById(c.env, c.req.param('id') ?? '');
  if (!tenant || tenant.status === 'deleted')
    throw new ApiError('NOT_FOUND', 404, 'No such shop');
  c.set('tenant', tenant);
  c.set('db', tenantDb(c.env, tenant));
  await next();
};
admin.use('/tenants/:id', loadTenant);
admin.use('/tenants/:id/*', loadTenant);

async function fresh(env: Env, id: string): Promise<TenantRow> {
  const t = await tenantById(env, id);
  if (!t) throw new ApiError('NOT_FOUND', 404, 'No such shop');
  return t;
}

admin.get('/tenants/:id', async (c) => {
  const { tenant, db } = c.var;
  const now = Date.now();
  const [shop, history, counts] = await db.batch([
    db.prepare(
      'SELECT name, setup_completed_at FROM shop WHERE tenant_id = ?1',
    ),
    db.prepare(
      "SELECT after_json, created_at FROM audit_log WHERE tenant_id = ?1 AND action = 'tenant_status_change' ORDER BY created_at DESC LIMIT 50",
    ),
    db.prepare(
      "SELECT (SELECT COUNT(*) FROM devices WHERE tenant_id = ?1 AND revoked_at IS NULL) AS devices, (SELECT COUNT(*) FROM sync_conflicts WHERE tenant_id = ?1 AND resolution = 'needs_owner') AS conflicts",
    ),
  ]);
  const s = shop?.results?.[0] as
    | { name: string; setup_completed_at: number | null }
    | undefined;
  const n = (counts?.results?.[0] ?? {}) as {
    devices?: number;
    conflicts?: number;
  };
  return c.json({
    tenant,
    shop_name: s?.name ?? null,
    setup_completed_at: s?.setup_completed_at ?? null,
    devices: n.devices ?? 0,
    open_conflicts: n.conflicts ?? 0,
    usage: await usageHistory(c.env, tenant.id, 7),
    status_history: (
      (history?.results ?? []) as { after_json: string; created_at: number }[]
    ).map((r) => ({
      ...(JSON.parse(r.after_json) as Record<string, unknown>),
      at: r.created_at,
    })),
    support: supportPayload(tenant, now),
  });
});

admin.patch('/tenants/:id', async (c) => {
  const { tenant, db } = c.var;
  const now = Date.now();
  const patch = z
    .object({
      display_name: z.string().trim().min(1).max(60).optional(),
      daily_write_budget: BUDGET.optional(),
      poll_after_ms: z.number().int().min(15_000).max(3_600_000).optional(),
      note: z.string().max(500).optional(),
      owner_email: Email.nullable().optional(),
    })
    .strict()
    .parse(await c.req.json());
  const stmt = patchTenantStatement(c.env, tenant.id, patch, now);
  const extra =
    patch.owner_email !== undefined && patch.owner_email !== tenant.owner_email
      ? auditStatements(db, {
          action: 'owner_email_change',
          before: tenant.owner_email
            ? { email: maskEmail(tenant.owner_email) }
            : null,
          after: patch.owner_email
            ? { email: maskEmail(patch.owner_email) }
            : null,
          now,
        })
      : [];
  if (stmt) await db.batch([stmt, ...extra]);
  return c.json({ tenant: await fresh(c.env, tenant.id) });
});

async function changeStatus(
  c: { env: Env; var: AdminEnv['Variables'] },
  to: TenantStatus,
  reason: string,
) {
  const { tenant } = c.var;
  if (!statusChangeAllowed(tenant.status, to)) {
    throw new ApiError(
      'BAD_STATUS_CHANGE',
      409,
      `Cannot go from ${tenant.status} to ${to}`,
    );
  }
  const now = Date.now();
  const res = await c.var.db.batch(
    statusChangeStatements(c.env, tenant, to, reason, by(c.var.operator), now),
  );
  if ((res[0]?.meta.changes ?? 0) !== 1)
    throw new ApiError(
      'BAD_STATUS_CHANGE',
      409,
      'The status changed meanwhile',
    );
  return fresh(c.env, tenant.id);
}

admin.post('/tenants/:id/read-only', async (c) => {
  const { reason } = z.object({ reason: Reason }).parse(await c.req.json());
  return c.json({ tenant: await changeStatus(c, 'read_only', reason) });
});
admin.post('/tenants/:id/suspend', async (c) => {
  const { reason } = z.object({ reason: Reason }).parse(await c.req.json());
  return c.json({ tenant: await changeStatus(c, 'suspended', reason) });
});
admin.post('/tenants/:id/reactivate', async (c) => {
  const body = z
    .object({
      reason: Reason,
      to: z.enum(['active', 'read_only']).default('active'),
    })
    .parse(await c.req.json());
  const from = c.var.tenant.status;
  if (
    from === 'maintenance' ||
    from === 'deleting' ||
    (from === 'active' && body.to === 'active')
  ) {
    throw new ApiError(
      'BAD_STATUS_CHANGE',
      409,
      `Cannot reactivate from ${from}`,
    );
  }
  return c.json({ tenant: await changeStatus(c, body.to, body.reason) });
});
admin.post('/tenants/:id/delete', async (c) => {
  const body = z
    .object({ confirm_slug: z.string(), reason: Reason })
    .parse(await c.req.json());
  if (body.confirm_slug !== c.var.tenant.slug)
    throw new ApiError('VALIDATION_FAILED', 400, 'Type the slug to confirm');
  return c.json(
    { tenant: await changeStatus(c, 'deleting', body.reason) },
    202,
  );
});

// Support access (13 §7.5).
admin.post('/tenants/:id/support-access', async (c) => {
  const { tenant, db } = c.var;
  const body = z
    .object({
      reason: Reason,
      hours: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(4),
        z.literal(8),
        z.literal(24),
      ]),
    })
    .parse(await c.req.json());
  if (tenant.status !== 'active' && tenant.status !== 'read_only') {
    throw new ApiError(
      'BAD_STATUS_CHANGE',
      409,
      'Support access needs an active or read-only shop',
    );
  }
  const now = Date.now();
  const until = now + body.hours * 3_600_000;
  const branch = await defaultBranch(db);
  const code = await enrolmentCodeStatement(c.env, tenant.id, {
    device_name: 'Algovyn support',
    branch_id: branch,
    grants_admin: false,
    kind: 'support',
    created_by: by(c.var.operator),
    now,
    ttl_ms: TILL_CODE_TTL_MS,
  });
  await db.batch([
    supportStatement(c.env, tenant.id, until, body.reason, now),
    db.prepare(
      "DELETE FROM enrolment_codes WHERE tenant_id = ?1 AND kind = 'support' AND used_at IS NULL",
    ),
    code.statement,
    ...auditStatements(db, {
      action: 'support_access_start',
      after: {
        reason: body.reason,
        until,
        hours: body.hours,
        by: by(c.var.operator),
      },
      now,
    }),
  ]);
  return c.json(
    { ...issued(c.env, c, code.code, code.expires_at), support_until: until },
    201,
  );
});

admin.post('/tenants/:id/support-access/end', async (c) => {
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
    ...auditStatements(db, {
      action: 'support_access_end',
      after: { ended_by: 'operator' },
      now,
    }),
  ]);
  return c.json({ ended: true });
});

async function defaultBranch(db: TenantDb): Promise<string> {
  const b = await db.first<{ id: string }>(
    'SELECT id FROM branches WHERE tenant_id = ?1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1',
  );
  if (!b)
    throw new ApiError('CONSTRAINT_FAILED', 409, 'The shop has no branch');
  return b.id;
}

admin.post('/tenants/:id/enrolment-codes', async (c) => {
  const { tenant, db } = c.var;
  const body = z
    .object({
      device_name: z.string().trim().min(1).max(40).default('Owner'),
      branch_id: z.string().max(40).optional(),
      grants_admin: z.boolean().default(true),
    })
    .parse(await c.req.json());
  const now = Date.now();
  const branch = body.branch_id ?? (await defaultBranch(db));
  const code = await enrolmentCodeStatement(c.env, tenant.id, {
    device_name: body.device_name,
    branch_id: branch,
    grants_admin: body.grants_admin,
    created_by: by(c.var.operator),
    now,
    ttl_ms: body.grants_admin ? OWNER_CODE_TTL_MS : TILL_CODE_TTL_MS,
  });
  await db.batch([
    // A new owner pairing code cancels the previous unused one (screens/19).
    ...(body.grants_admin
      ? [
          db.prepare(
            "DELETE FROM enrolment_codes WHERE tenant_id = ?1 AND grants_admin = 1 AND kind = 'till' AND used_at IS NULL",
          ),
        ]
      : []),
    code.statement,
    ...auditStatements(db, {
      action: 'device_enrol_code',
      after: {
        device_name: body.device_name,
        is_admin: body.grants_admin,
        by: by(c.var.operator),
      },
      now,
    }),
  ]);
  return c.json(issued(c.env, c, code.code, code.expires_at), 201);
});

admin.get('/tenants/:id/devices', async (c) => {
  const rows = await c.var.db.select<DeviceRow>(
    'SELECT * FROM devices WHERE tenant_id = ?1 ORDER BY revoked_at IS NOT NULL, enrolled_at',
  );
  return c.json({
    devices: rows.map(({ token_hash: _hidden, ...d }) => ({
      ...d,
      is_admin: d.is_admin === 1,
    })),
  });
});

admin.post('/tenants/:id/devices/:deviceId/revoke', async (c) => {
  const { db } = c.var;
  const now = Date.now();
  const id = c.req.param('deviceId');
  const device = await db.first<DeviceRow>(
    'SELECT * FROM devices WHERE tenant_id = ?1 AND id = ?2',
    id,
  );
  if (!device)
    throw new ApiError('NOT_FOUND', 404, 'No such device in this shop');
  if (device.revoked_at !== null)
    return c.json({ revoked_at: device.revoked_at });
  await db.batch([
    db.prepare(
      'UPDATE devices SET revoked_at = ?2, updated_at = ?2 WHERE tenant_id = ?1 AND id = ?3',
      now,
      id,
    ),
    changeLogStatement(db, 'devices', id, 'upsert', null, now),
    ...auditStatements(db, {
      action: 'device_revoke',
      entity: 'devices',
      entityId: id,
      after: { name: device.name, by: by(c.var.operator) },
      now,
    }),
  ]);
  return c.json({ revoked_at: now });
});

admin.post('/tenants/:id/import-ops', async (c) => {
  const { tenant, db } = c.var;
  const body = ImportOpsBody.parse(await c.req.json());
  const now = Date.now();
  const out = await importOps(c.env, db, tenant, body.device_id, body.ops, now);
  await db.batch(
    auditStatements(db, {
      action: 'ops_import',
      entity: 'devices',
      entityId: body.device_id,
      after: {
        ops: body.ops.length,
        applied: out.results.length,
        by: by(c.var.operator),
      },
      now,
    }),
  );
  return c.json(out);
});

admin.post('/tenants/:id/reset-owner-pin', async (c) => {
  const { db } = c.var;
  const body = z
    .object({
      staff_id: z.string().max(40),
      pin_hash: z.string().min(16).max(200),
      pin_salt: z.string().min(8).max(200),
      pin_iterations: z.number().int().min(100_000).max(1_000_000),
    })
    .parse(await c.req.json());
  const now = Date.now();
  const res = await db.batch([
    db.prepare(
      "UPDATE staff SET pin_hash = ?3, pin_salt = ?4, pin_iterations = ?5, rev = rev + 1, updated_at = ?6, updated_by = 'server' WHERE tenant_id = ?1 AND id = ?2 AND role = 'owner' AND deleted_at IS NULL",
      body.staff_id,
      body.pin_hash,
      body.pin_salt,
      body.pin_iterations,
      now,
    ),
  ]);
  if ((res[0]?.meta.changes ?? 0) !== 1)
    throw new ApiError('NOT_FOUND', 404, 'No such owner in this shop');
  await db.batch([
    changeLogStatement(db, 'staff', body.staff_id, 'upsert', null, now),
    ...auditStatements(db, {
      action: 'pin_reset',
      entity: 'staff',
      entityId: body.staff_id,
      after: { by: by(c.var.operator) },
      now,
    }),
  ]);
  return c.json({ ok: true });
});

admin.get('/tenants/:id/owners', async (c) => {
  const rows = await c.var.db.select<{
    id: string;
    name: string;
    active: number;
  }>(
    "SELECT id, name, active FROM staff WHERE tenant_id = ?1 AND role = 'owner' AND deleted_at IS NULL ORDER BY created_at",
  );
  return c.json({ owners: rows });
});

// Export (I17) and restore (I18), 09 §3.4.
admin.get('/tenants/:id/export', async (c) => {
  const { tenant, db } = c.var;
  const payload = await snapshotPayload(
    (k) => c.req.query(k),
    db,
    tenant,
    1000,
  );
  if (!c.req.query('tbl')) {
    await db.batch(
      auditStatements(db, {
        action: 'operator_export',
        after: { by: by(c.var.operator) },
        now: Date.now(),
      }),
    );
    return c.json({
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        display_name: tenant.display_name,
      },
      ...payload,
    });
  }
  return c.json(payload);
});

admin.post('/tenants/:id/maintenance', async (c) => {
  const { tenant, db } = c.var;
  const body = z
    .object({
      on: z.boolean(),
      reason: z.string().trim().max(200).default('Restore'),
      to: z.enum(['active', 'read_only', 'suspended']).optional(),
    })
    .parse(await c.req.json());
  if (body.on) {
    if (tenant.status === 'maintenance') return c.json({ tenant });
    return c.json({
      tenant: await changeStatus(c, 'maintenance', body.reason || 'Restore'),
    });
  }
  if (tenant.status !== 'maintenance') return c.json({ tenant });
  const to = body.to ?? (await statusBeforeMaintenance(db));
  return c.json({
    tenant: await changeStatus(c, to, body.reason || 'Restore finished'),
  });
});

/** Default for `maintenance off`: the status before maintenance (13 §7.2), else active (D-105). */
async function statusBeforeMaintenance(
  db: TenantDb,
): Promise<'active' | 'read_only' | 'suspended'> {
  const row = await db.first<{ after_json: string }>(
    "SELECT after_json FROM audit_log WHERE tenant_id = ?1 AND action = 'tenant_status_change' ORDER BY created_at DESC LIMIT 1",
  );
  const last = row
    ? (JSON.parse(row.after_json) as { from?: string; to?: string })
    : {};
  const s = last.to === 'maintenance' ? last.from : last.to;
  return s === 'read_only' || s === 'suspended' ? s : 'active';
}

function assertMaintenance(tenant: TenantRow): void {
  if (tenant.status !== 'maintenance')
    throw new ApiError('NOT_IN_MAINTENANCE', 409, 'Turn maintenance on first');
}

/** Tables purged by a restore, children first. Devices, codes and branches stay (D-105). */
export const PURGE_ORDER = [
  'change_log',
  'applied_ops',
  'sync_conflicts',
  'owner_email_codes',
  ...[...APPLY_ORDER].reverse().filter((t) => t !== 'branches'),
] as const;

admin.post('/tenants/:id/purge', async (c) => {
  const { tenant, db } = c.var;
  assertMaintenance(tenant);
  const counts = async () => {
    const res = await db.batch(
      PURGE_ORDER.map((t) =>
        db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id = ?1`),
      ),
    );
    return PURGE_ORDER.map((t, i) => ({
      t,
      n: Number((res[i]?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
    }));
  };
  let left = PURGE_CHUNK;
  let deleted = 0;
  for (const { t, n } of await counts()) {
    if (n === 0) continue;
    if (left <= 0) break;
    const r = await db.run(
      `DELETE FROM ${t} WHERE tenant_id = ?1 AND rowid IN (SELECT rowid FROM ${t} WHERE tenant_id = ?1 LIMIT ?2)`,
      Math.min(left, n),
    );
    left -= r.meta.changes ?? 0;
    deleted += r.meta.changes ?? 0;
  }
  const remaining = (await counts()).reduce((s, x) => s + x.n, 0);
  return c.json({ deleted, remaining });
});

const IMPORT_TABLES = SNAPSHOT_TABLES.filter((t) => t !== 'devices');
const Scalar = z.union([z.string(), z.number(), z.null()]);

admin.post('/tenants/:id/import', async (c) => {
  const { tenant, db } = c.var;
  assertMaintenance(tenant);
  const body = z
    .object({
      tbl: z.enum(IMPORT_TABLES as unknown as [string, ...string[]]),
      rows: z.array(z.record(z.string(), Scalar)).min(1).max(500),
      reason: z.string().trim().max(200).optional(),
    })
    .parse(await c.req.json());
  const tbl = body.tbl as (typeof IMPORT_TABLES)[number];
  const allowed = new Set(clientColumns(tbl));
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const raw of body.rows) {
    const { tenant_id: _ignored, ...row } = raw;
    for (const k of Object.keys(row)) {
      if (!allowed.has(k))
        throw new ApiError(
          'VALIDATION_FAILED',
          400,
          `Unknown column ${tbl}.${k}`,
        );
    }
    if (typeof row.id !== 'string' || row.id.length > 64)
      throw new ApiError('VALIDATION_FAILED', 400, 'Every row needs an id');
    for (const [k, value] of Object.entries(row)) {
      if (typeof value === 'string' && value.length > 4_000)
        throw new ApiError(
          'VALIDATION_FAILED',
          400,
          `Value too long: ${tbl}.${k}`,
        );
      if (typeof value === 'number' && !Number.isSafeInteger(value))
        throw new ApiError(
          'VALIDATION_FAILED',
          400,
          `Number out of range: ${tbl}.${k}`,
        );
    }
    stmts.push(
      db.upsert(tbl, row),
      changeLogStatement(db, tbl, row.id, 'upsert', null, now),
    );
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    throw new ApiError(
      'CONSTRAINT_FAILED',
      400,
      String((e as Error).message).slice(0, 200),
    );
  }
  await db.batch(
    auditStatements(db, {
      action: 'operator_import',
      entity: 'shop',
      entityId: 'shop',
      after: {
        tbl,
        rows: body.rows.length,
        ...(body.reason ? { reason: body.reason } : {}),
        by: by(c.var.operator),
      },
      now,
    }),
  );
  return c.json({ imported: body.rows.length });
});

admin.post('/tenants/:id/restore-epoch', async (c) => {
  const { tenant, db } = c.var;
  assertMaintenance(tenant);
  const { restore_point_at, reason } = z
    .object({
      restore_point_at: z.number().int().min(0),
      reason: z.string().trim().max(200).optional(),
    })
    .parse(await c.req.json());
  const now = Date.now();
  await db.batch([
    restoreEpochStatement(c.env, tenant.id, restore_point_at, now),
    ...auditStatements(db, {
      action: 'tenant_restore',
      after: {
        restore_point_at,
        ...(reason ? { reason } : {}),
        by: by(c.var.operator),
      },
      now,
    }),
  ]);
  return c.json({ tenant: await fresh(c.env, tenant.id) });
});

// Backups (09 §2): whole-database dumps in the BACKUPS bucket.
admin.get('/backups', async (c) => {
  const prefix = z
    .string()
    .regex(/^[a-z0-9/_-]{0,40}$/)
    .parse(c.req.query('prefix') ?? 'd1/');
  const listed = await c.env.BACKUPS.list({ prefix, limit: 1000 });
  return c.json({
    objects: listed.objects
      .map((o) => ({
        key: o.key,
        size: o.size,
        uploaded: o.uploaded.getTime(),
      }))
      .sort((a, b) => b.uploaded - a.uploaded),
  });
});

admin.get('/backups/download', async (c) => {
  const key = z
    .string()
    .regex(/^[a-z0-9/_.-]{1,120}$/)
    .parse(c.req.query('key'));
  if (key.includes('..'))
    throw new ApiError('VALIDATION_FAILED', 400, 'Bad key');
  const obj = await c.env.BACKUPS.get(key);
  if (!obj) throw new ApiError('NOT_FOUND', 404, 'No such backup');
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${key.split('/').pop()}"`,
    },
  });
});
