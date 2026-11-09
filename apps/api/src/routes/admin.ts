/** Operator endpoints behind Cloudflare Access (04 §3.7, screens/19). */
import { isLedgerTable } from '@bikri/core';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { type TenantDb, tenantDb } from '../db/tenantDb.ts';
import { ApiError } from '../errors.ts';
import type { OperatorVars } from '../middleware/accessAuth.ts';
import { readJsonBody } from '../middleware/body.ts';
import {
  createTenant,
  enrolLink,
  enrolmentCodeStatement,
  OWNER_CODE_TTL_MS,
  SlugTakenError,
  TILL_CODE_TTL_MS,
} from '../platform/createTenant.ts';
import { gcTenantFiles } from '../platform/filesGc.ts';
import {
  addRequestEmail,
  approveShopRequest,
  checkRequestEmail,
  getShopRequest,
  listShopRequests,
  manualVerifyRequestEmail,
  rejectShopRequest,
  reopenShopRequest,
  type ShopRequestStatus,
} from '../platform/shopRequests.ts';
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
import { usageToday } from '../platform/tenants.ts';
import { auditStatements } from '../sync/audit.ts';
import { changeLogStatement } from '../sync/changeLog.ts';
import { importOps } from '../sync/importOps.ts';
import { ImportOpsBody } from '../sync/opSchema.ts';
import { revokeSupportDevices, supportPayload } from '../sync/status.ts';
import { APPLY_ORDER, clientColumns, SNAPSHOT_TABLES } from '../sync/tables.ts';
import type { DeviceRow, TenantRow, TenantStatus } from '../types.ts';
import { assertReadQuota, snapshotPayload } from './sync.ts';

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
    open_conflicts: list.tenants
      .filter((tenant) => tenant.conflicts > 0)
      .map((tenant) => ({
        tenant_id: tenant.id,
        count: tenant.conflicts,
      })),
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
    .parse(await readJsonBody(c, 64 * 1024));
  try {
    const { tenant, owner_code } = await createTenant(c.env, {
      ...body,
      owner_email: body.owner_email ?? null,
      created_by_email: c.var.operator,
    });
    const tdb = tenantDb(c.env, tenant);
    await tdb.batch(
      auditStatements(tdb, {
        action: 'shop_created',
        after: { by: by(c.var.operator) },
        now: Date.now(),
      }),
    );
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

// ---- public shop requests (D-175) -----------------------------------------------------------
const RequestStatus = z.enum([
  'pending',
  'awaiting_email',
  'email_verified',
  'approving',
  'approved',
  'rejected',
  'failed',
]);

admin.get('/shop-requests', async (c) => {
  const status = c.req.query('status');
  const parsed = status ? RequestStatus.parse(status) : null;
  const q = (c.req.query('q') ?? '').slice(0, 100);
  return c.json({
    requests: await listShopRequests(c.env, {
      status: parsed as ShopRequestStatus | null,
      q,
    }),
  });
});

admin.get('/shop-requests/:id', async (c) => {
  const detail = await getShopRequest(c.env, c.req.param('id'));
  if (!detail) throw new ApiError('NOT_FOUND', 404, 'No such shop request');
  return c.json(detail);
});

admin.post('/shop-requests/:id/email', async (c) =>
  c.json(await addRequestEmail(c.env, c.req.param('id'), c.var.operator)),
);

admin.get('/shop-requests/:id/email-status', async (c) =>
  c.json(await checkRequestEmail(c.env, c.req.param('id'), c.var.operator)),
);

admin.post('/shop-requests/:id/email/manual', async (c) => {
  const body = z
    .object({ note: z.string().trim().min(1).max(200) })
    .parse(await readJsonBody(c, 64 * 1024));
  await manualVerifyRequestEmail(
    c.env,
    c.req.param('id'),
    c.var.operator,
    body.note,
  );
  const detail = await getShopRequest(c.env, c.req.param('id'));
  return c.json(detail);
});

admin.post('/shop-requests/:id/approve', async (c) => {
  const body = z
    .object({
      slug: Slug.optional(),
      daily_write_budget: BUDGET.optional(),
      note: z.string().trim().max(500).optional(),
    })
    .parse(
      await readJsonBody(c, 64 * 1024).catch((error: unknown) => {
        // An empty body is allowed (auto slug/budget), but a malformed or oversized
        // body must fail instead of silently approving with defaults.
        if (error instanceof ApiError) throw error;
        return {};
      }),
    );
  return c.json(
    await approveShopRequest(c.env, c.req.param('id'), c.var.operator, {
      ...body,
      origin: origin(c),
      base_path: String(c.env.BASE_PATH),
    }),
  );
});

admin.post('/shop-requests/:id/reject', async (c) => {
  const body = z
    .object({ reason: Reason })
    .parse(await readJsonBody(c, 64 * 1024));
  return c.json(
    await rejectShopRequest(
      c.env,
      c.req.param('id'),
      c.var.operator,
      body.reason,
    ),
  );
});

admin.post('/shop-requests/:id/reopen', async (c) => {
  const body = z
    .object({ reason: Reason })
    .parse(await readJsonBody(c, 64 * 1024));
  return c.json(
    await reopenShopRequest(
      c.env,
      c.req.param('id'),
      c.var.operator,
      body.reason,
    ),
  );
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
      "SELECT after_json, created_at FROM audit_log WHERE tenant_id = ?1 AND action = 'tenant_status_change' AND device_id = 'server' ORDER BY created_at DESC LIMIT 50",
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
    ).flatMap((r) => {
      try {
        return [
          {
            ...(JSON.parse(r.after_json) as Record<string, unknown>),
            at: r.created_at,
          },
        ];
      } catch {
        return [];
      }
    }),
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
    .parse(await readJsonBody(c, 64 * 1024));
  const stmt = patchTenantStatement(c.env, tenant.id, patch, now);
  const extra: D1PreparedStatement[] = [];
  const fields = [
    'display_name',
    'daily_write_budget',
    'poll_after_ms',
    'note',
  ] as const;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of fields) {
    if (patch[field] === undefined || patch[field] === tenant[field]) continue;
    before[field] = tenant[field];
    after[field] = patch[field];
  }
  if (Object.keys(after).length > 0) {
    extra.push(
      ...auditStatements(db, {
        action: 'tenant_change',
        before,
        after: { ...after, by: by(c.var.operator) },
        now,
      }),
    );
  }
  if (
    patch.owner_email !== undefined &&
    patch.owner_email !== tenant.owner_email
  )
    extra.push(
      ...auditStatements(db, {
        action: 'owner_email_change',
        before: tenant.owner_email
          ? { email: maskEmail(tenant.owner_email) }
          : null,
        after: patch.owner_email
          ? { email: maskEmail(patch.owner_email) }
          : null,
        now,
      }),
    );
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
  const statements = statusChangeStatements(
    c.env,
    tenant,
    to,
    reason,
    by(c.var.operator),
    now,
  );
  const res = await c.var.db.batch(statements);
  if ((res[0]?.meta.changes ?? 0) !== 1)
    throw new ApiError(
      'BAD_STATUS_CHANGE',
      409,
      'The status changed meanwhile',
    );
  // The audit row is guarded by `changes() = 1`, and the device side effects are guarded by
  // the new tenant status, so a lost CAS never leaves an audit row or side effect behind.
  return fresh(c.env, tenant.id);
}

admin.post('/tenants/:id/read-only', async (c) => {
  const { reason } = z
    .object({ reason: Reason })
    .parse(await readJsonBody(c, 64 * 1024));
  return c.json({ tenant: await changeStatus(c, 'read_only', reason) });
});
admin.post('/tenants/:id/suspend', async (c) => {
  const { reason } = z
    .object({ reason: Reason })
    .parse(await readJsonBody(c, 64 * 1024));
  return c.json({ tenant: await changeStatus(c, 'suspended', reason) });
});
admin.post('/tenants/:id/reactivate', async (c) => {
  const body = z
    .object({
      reason: Reason,
      to: z.enum(['active', 'read_only']).default('active'),
    })
    .parse(await readJsonBody(c, 64 * 1024));
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
    .parse(await readJsonBody(c, 64 * 1024));
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
    .parse(await readJsonBody(c, 64 * 1024));
  if (tenant.status !== 'active' && tenant.status !== 'read_only') {
    throw new ApiError(
      'BAD_STATUS_CHANGE',
      409,
      'Support access needs an active or read-only shop',
    );
  }
  const now = Date.now();
  // Starting again extends an existing grant; it must never shorten it.
  const until = Math.max(
    tenant.support_until ?? 0,
    now + body.hours * 3_600_000,
  );
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
    // Extending support also extends devices that are already enrolled. Read the
    // committed tenant value, not the value this request loaded: a concurrent grant
    // may have extended it further.
    db.prepare(
      "UPDATE devices SET expires_at = MAX(COALESCE(expires_at, 0), (SELECT support_until FROM tenants WHERE id = ?1)), updated_at = ?2 WHERE tenant_id = ?1 AND kind = 'support' AND revoked_at IS NULL",
      now,
    ),
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
  const committed = await fresh(c.env, tenant.id);
  return c.json(
    {
      ...issued(c.env, c, code.code, code.expires_at),
      support_until: committed.support_until,
    },
    201,
  );
});

admin.post('/tenants/:id/support-access/end', async (c) => {
  const { tenant, db } = c.var;
  const now = Date.now();
  if (tenant.support_until === null || tenant.support_until <= now)
    return c.json({ ended: false });
  await db.batch([
    supportStatement(c.env, tenant.id, now, tenant.support_reason, now, 'set'),
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
    .parse(await readJsonBody(c, 64 * 1024));
  const now = Date.now();
  const branch = body.branch_id ?? (await defaultBranch(db));
  if (body.branch_id) {
    const exists = await db.first(
      'SELECT id FROM branches WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL',
      body.branch_id,
    );
    if (!exists) throw new ApiError('NOT_FOUND', 404, 'No such branch');
  }
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
  const rows = await c.var.db.select<
    DeviceRow & { branch_name: string | null }
  >(
    'SELECT d.*, b.name AS branch_name FROM devices d LEFT JOIN branches b ON b.tenant_id = d.tenant_id AND b.id = d.branch_id WHERE d.tenant_id = ?1 AND b.tenant_id = ?1 ORDER BY d.revoked_at IS NOT NULL, d.enrolled_at',
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
  const body = ImportOpsBody.parse(await readJsonBody(c, 1_000_000));
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
      pin_length: z.number().int().min(4).max(6),
    })
    .parse(await readJsonBody(c, 64 * 1024));
  const now = Date.now();
  const res = await db.batch([
    db.prepare(
      "UPDATE staff SET pin_hash = ?3, pin_salt = ?4, pin_iterations = ?5, pin_length = ?6, rev = rev + 1, updated_at = ?7, updated_by = 'server' WHERE tenant_id = ?1 AND id = ?2 AND role = 'owner' AND active = 1 AND deleted_at IS NULL",
      body.staff_id,
      body.pin_hash,
      body.pin_salt,
      body.pin_iterations,
      body.pin_length,
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
  const exportedAt = Date.now();
  assertReadQuota(tenant, await usageToday(c.env, tenant.id, exportedAt));
  if (c.req.query('tbl') && !c.req.query('before'))
    throw new ApiError(
      'VALIDATION_FAILED',
      400,
      'Export pages need the exported_at cutoff',
    );
  const payload = await snapshotPayload(
    (k) => c.req.query(k) ?? (k === 'before' ? String(exportedAt) : undefined),
    db,
    tenant,
    1000,
  );
  if (!c.req.query('tbl')) {
    await db.batch(
      auditStatements(db, {
        action: 'operator_export',
        after: { by: by(c.var.operator) },
        now: exportedAt,
      }),
    );
    return c.json({
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        display_name: tenant.display_name,
      },
      exported_at: exportedAt,
      ...payload,
    });
  }
  return c.json(payload);
});

admin.post('/tenants/:id/files/gc', async (c) => {
  const { tenant, db } = c.var;
  const body = z
    .object({ dry_run: z.boolean().default(true) })
    .parse((await readJsonBody(c, 64 * 1024).catch(() => ({}))) as unknown);
  const now = Date.now();
  const result = await gcTenantFiles(c.env, tenant, {
    now,
    dryRun: body.dry_run,
  });
  await db.batch(
    auditStatements(db, {
      action: 'operator_file_gc',
      after: {
        ...result,
        dry_run: body.dry_run,
        by: by(c.var.operator),
      },
      now,
    }),
  );
  return c.json(result);
});

admin.post('/tenants/:id/maintenance', async (c) => {
  const { tenant, db } = c.var;
  const body = z
    .object({
      on: z.boolean(),
      reason: z.string().trim().max(200).default('Restore'),
      to: z.enum(['active', 'read_only', 'suspended']).optional(),
    })
    .parse(await readJsonBody(c, 64 * 1024));
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
    "SELECT after_json FROM audit_log WHERE tenant_id = ?1 AND action = 'tenant_status_change' AND device_id = 'server' ORDER BY created_at DESC LIMIT 1",
  );
  let last: { from?: string; to?: string } = {};
  if (row) {
    try {
      last = JSON.parse(row.after_json) as { from?: string; to?: string };
    } catch {
      last = {};
    }
  }
  const s = last.to === 'maintenance' ? last.from : last.to;
  return s === 'read_only' || s === 'suspended' ? s : 'active';
}

function assertMaintenance(tenant: TenantRow): void {
  if (tenant.status !== 'maintenance')
    throw new ApiError('NOT_IN_MAINTENANCE', 409, 'Turn maintenance on first');
}

/**
 * Tables purged by a restore, children first. Devices, codes and branches stay (D-105), and
 * `audit_log` stays: it is append-only (AGENTS.md) and `maintenance off` reads the last
 * `tenant_status_change` from it to restore the shop's previous status.
 */
export const PURGE_ORDER = [
  'change_log',
  'applied_ops',
  'sync_conflicts',
  'owner_email_codes',
  ...[...APPLY_ORDER]
    .reverse()
    .filter((t) => t !== 'branches' && t !== 'audit_log'),
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
  // Self-referencing rows (expense reversals, replacement sales) must be deleted before
  // the rows they point at. Do not UPDATE these append-only tables just to dodge an FK:
  // a purge that does not finish would otherwise leave their links permanently changed.
  const passesFor = (tbl: string): string[] =>
    tbl === 'expenses'
      ? ['reverses_id IS NOT NULL', '1 = 1']
      : tbl === 'sales'
        ? ['replaces_sale_id IS NOT NULL', '1 = 1']
        : ['1 = 1'];
  for (const { t, n } of await counts()) {
    if (n === 0 || left <= 0) continue;
    let pending = n;
    for (const where of passesFor(t)) {
      if (pending <= 0 || left <= 0) break;
      const r = await db.run(
        `DELETE FROM ${t} WHERE tenant_id = ?1 AND ${where} AND rowid IN (SELECT rowid FROM ${t} WHERE tenant_id = ?1 AND ${where} LIMIT ?2)`,
        Math.min(left, pending),
      );
      const changed = r.meta.changes ?? 0;
      left -= changed;
      deleted += changed;
      pending -= changed;
    }
  }
  const remaining = (await counts()).reduce((s, x) => s + x.n, 0);
  if (remaining === 0)
    await db.batch(
      auditStatements(db, {
        action: 'tenant_purge',
        after: { deleted, by: by(c.var.operator) },
        now: Date.now(),
      }),
    );
  return c.json({ deleted, remaining });
});

// `audit_log` is retained through a restore purge and is append-only; importing an
// older export must not rewrite it. `devices` are server-owned (D-105).
const IMPORT_TABLES = SNAPSHOT_TABLES.filter(
  (t) => t !== 'devices' && t !== 'audit_log',
);
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
    .parse(await readJsonBody(c, 4_000_000));
  const tbl = body.tbl as (typeof IMPORT_TABLES)[number];
  const allowed = new Set(clientColumns(tbl));
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const raw of body.rows) {
    if (raw.tenant_id !== undefined && raw.tenant_id !== tenant.id)
      throw new ApiError(
        'VALIDATION_FAILED',
        400,
        'A row belongs to another shop',
      );
    const { tenant_id: _ignored, ...row } = raw;
    for (const k of Object.keys(row)) {
      if (!allowed.has(k))
        throw new ApiError(
          'VALIDATION_FAILED',
          400,
          `Unknown column ${tbl}.${k}`,
        );
    }
    if (typeof row.id !== 'string' || row.id.length === 0 || row.id.length > 64)
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
      isLedgerTable(tbl) ? db.insertOnly(tbl, row) : db.upsert(tbl, row),
      changeLogStatement(db, tbl, row.id, 'upsert', null, now),
    );
  }
  try {
    await db.batch(stmts);
  } catch {
    throw new ApiError(
      'CONSTRAINT_FAILED',
      400,
      'The export rows do not satisfy the shop schema',
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
    .parse(await readJsonBody(c, 64 * 1024));
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
