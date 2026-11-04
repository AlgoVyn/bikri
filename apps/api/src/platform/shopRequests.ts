/**
 * Public shop registration requests (platform tables, D-175).
 *
 * The public form only creates a request. The operator reviews it, adds the email to
 * Cloudflare Email Routing, checks verification, and only then approves it. Approval
 * creates the tenant and the 72-hour owner pairing code (reusing createTenant).
 */
import { newId } from '@bikri/core';
import { newDeviceToken, sha256Hex } from '../auth/crypto.ts';
import { sendShopInviteEmail } from '../auth/mailer.ts';
import { tenantDb } from '../db/tenantDb.ts';
import { ApiError } from '../errors.ts';
import { auditStatements } from '../sync/audit.ts';
import {
  createTenant,
  enrolmentCodeStatement,
  OWNER_CODE_TTL_MS,
  SlugTakenError,
} from './createTenant.ts';
import { tenantById } from './tenantAdmin.ts';

export type ShopRequestStatus =
  | 'pending'
  | 'awaiting_email'
  | 'email_verified'
  | 'approving'
  | 'approved'
  | 'rejected'
  | 'failed';

export type ShopRequestRow = {
  id: string;
  shop_name: string;
  owner_name: string;
  email: string;
  phone: string;
  city: string;
  business_type: string;
  note: string;
  status: ShopRequestStatus;
  email_verification_sent_at: number | null;
  email_verified_at: number | null;
  email_checked_at: number | null;
  cloudflare_address_id: string | null;
  tenant_id: string | null;
  claim_tenant_id: string | null;
  reject_reason: string;
  last_error: string;
  reviewed_by: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
};

export type ShopRequestTenant = {
  id: string;
  slug: string;
  display_name: string;
  status: string;
  devices: number;
  setup_completed: boolean;
};

export type ShopRequestDetail = {
  request: ShopRequestRow;
  tenant: ShopRequestTenant | null;
};

export type NewShopRequest = {
  shop_name: string;
  owner_name: string;
  email: string;
  phone: string;
  city: string;
  business_type: string;
  note: string;
};

export type ApproveInput = {
  slug?: string;
  daily_write_budget?: number;
  note?: string;
  origin: string;
  base_path: string;
};

const CF_API = 'https://api.cloudflare.com/client/v4';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

const normaliseEmail = (email: string) => email.trim().toLowerCase();

function emailOk(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

async function audit(
  env: Env,
  input: {
    action:
      | 'shop_request_email_added'
      | 'shop_request_email_verified'
      | 'shop_request_email_manual'
      | 'shop_request_approve'
      | 'shop_request_reject'
      | 'shop_request_reopen';
    requestId: string;
    tenantId?: string | null;
    operator: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
    now: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO operator_audit
       (id, action, request_id, tenant_id, operator_email, reason, before_json, after_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      newId(input.now),
      input.action,
      input.requestId,
      input.tenantId ?? null,
      input.operator,
      (input.reason ?? '').slice(0, 200),
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.now,
    )
    .run();
}

async function requestById(
  env: Env,
  id: string,
): Promise<ShopRequestRow | null> {
  return env.DB.prepare('SELECT * FROM shop_requests WHERE id = ?1')
    .bind(id)
    .first<ShopRequestRow>();
}

async function requireRequest(env: Env, id: string): Promise<ShopRequestRow> {
  const row = await requestById(env, id);
  if (!row) throw new ApiError('NOT_FOUND', 404, 'No such shop request');
  return row;
}

/** Creates a pending request. A duplicate active email gets a fresh status token, not a second row. */
export async function createShopRequest(
  env: Env,
  input: NewShopRequest,
  now = Date.now(),
): Promise<{ id: string; token: string | null; duplicate: boolean }> {
  const email = normaliseEmail(input.email);
  if (!emailOk(email))
    throw new ApiError('VALIDATION_FAILED', 400, 'Enter a valid email address');
  const token = newDeviceToken();
  const hash = await sha256Hex(token);
  const id = newId(now);
  try {
    await env.DB.prepare(
      `INSERT INTO shop_requests
         (id, shop_name, owner_name, email, phone, city, business_type, note, status, status_token_hash, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?10)`,
    )
      .bind(
        id,
        input.shop_name.trim().slice(0, 60),
        input.owner_name.trim().slice(0, 60),
        email,
        input.phone.trim().slice(0, 30),
        input.city.trim().slice(0, 60),
        input.business_type.trim().slice(0, 40) || 'other',
        input.note.trim().slice(0, 500),
        hash,
        now,
      )
      .run();
  } catch (error) {
    if (!String((error as Error).message).includes('UNIQUE')) throw error;
    const existing = await env.DB.prepare(
      `SELECT id FROM shop_requests
        WHERE lower(email) = ?1
          AND status IN ('pending','awaiting_email','email_verified','approving')`,
    )
      .bind(email)
      .first<{ id: string }>();
    if (!existing) throw error;
    // Never let anyone who merely knows the email rewrite the request or replace its
    // status token. The original applicant keeps the only status link.
    return { id: existing.id, token: null, duplicate: true };
  }
  return { id, token, duplicate: false };
}

export type PublicRequestStatus = {
  shop_name: string;
  email: string;
  status: ShopRequestStatus;
  created_at: number;
  email_verified_at: number | null;
  reject_reason: string;
};

/** Status page lookup by the random token (the token is sent in a POST body, not a URL). */
export async function statusByToken(
  env: Env,
  token: string,
): Promise<PublicRequestStatus | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT shop_name, email, status, created_at, email_verified_at, reject_reason
       FROM shop_requests WHERE status_token_hash = ?1`,
  )
    .bind(hash)
    .first<{
      shop_name: string;
      email: string;
      status: ShopRequestStatus;
      created_at: number;
      email_verified_at: number | null;
      reject_reason: string;
    }>();
  if (!row) return null;
  return { ...row, email: maskEmail(row.email) };
}

export async function listShopRequests(
  env: Env,
  opts: { status?: ShopRequestStatus | null; q?: string; limit?: number } = {},
): Promise<ShopRequestRow[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q) {
    where.push(
      '(instr(lower(shop_name), ?) > 0 OR instr(lower(owner_name), ?) > 0 OR instr(lower(email), ?) > 0 OR instr(phone, ?) > 0)',
    );
    params.push(q, q, q, q);
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  params.push(limit);
  const { results } = await env.DB.prepare(
    `SELECT * FROM shop_requests
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...params)
    .all<ShopRequestRow>();
  return results;
}

export async function getShopRequest(
  env: Env,
  id: string,
): Promise<ShopRequestDetail | null> {
  const request = await requestById(env, id);
  if (!request) return null;
  let tenant: ShopRequestTenant | null = null;
  if (request.tenant_id) {
    const row = await env.DB.prepare(
      `SELECT t.id, t.slug, t.display_name, t.status,
         (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id AND d.revoked_at IS NULL) AS devices,
         (SELECT COUNT(*) FROM shop s WHERE s.tenant_id = t.id AND s.setup_completed_at IS NOT NULL) AS setup
       FROM tenants t WHERE t.id = ?1`,
    )
      .bind(request.tenant_id)
      .first<{
        id: string;
        slug: string;
        display_name: string;
        status: string;
        devices: number;
        setup: number;
      }>();
    if (row)
      tenant = {
        id: row.id,
        slug: row.slug,
        display_name: row.display_name,
        status: row.status,
        devices: Number(row.devices),
        setup_completed: Number(row.setup) > 0,
      };
  }
  return { request, tenant };
}

// ---- Cloudflare Email Routing ---------------------------------------------------------------

type CfAddress = { id?: unknown; email?: unknown; verified?: unknown };
type CfResponse = {
  success?: boolean;
  result?: unknown;
  errors?: { code?: unknown; message?: unknown }[];
};

function cloudflare(env: Env): { account: string; token: string } {
  const account = String(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const token = String(env.EMAIL_ROUTING_TOKEN ?? '').trim();
  if (!account || !token)
    throw new ApiError(
      'EMAIL_ROUTING_NOT_CONFIGURED',
      503,
      'Cloudflare Email Routing is not configured',
    );
  return { account, token };
}

async function cf(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const { account, token } = cloudflare(env);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('content-type', 'application/json');
  const response = await fetch(
    `${CF_API}/accounts/${account}/email/routing${path}`,
    { ...init, headers },
  );
  let body: CfResponse | null = null;
  try {
    body = (await response.json()) as CfResponse;
  } catch {
    body = null;
  }
  if (!response.ok || body?.success !== true) {
    const code = body?.errors?.[0]?.code;
    throw new ApiError(
      'EMAIL_ROUTING_FAILED',
      502,
      'Cloudflare Email Routing could not complete this request',
      { code: typeof code === 'number' ? code : null },
    );
  }
  return body.result;
}

async function findCfAddress(
  env: Env,
  email: string,
): Promise<CfAddress | null> {
  const result = await cf(env, '/addresses?per_page=1000', { method: 'GET' });
  if (!Array.isArray(result)) return null;
  return (
    (result as CfAddress[]).find(
      (row) =>
        typeof row.email === 'string' &&
        row.email.toLowerCase() === email.toLowerCase(),
    ) ?? null
  );
}

/** Adds the request's email to Cloudflare (or reuses an existing destination) and records it. */
export async function addRequestEmail(
  env: Env,
  id: string,
  operator: string,
  now = Date.now(),
): Promise<{
  email: string;
  verified: boolean;
  status: ShopRequestStatus;
  already_added: boolean;
}> {
  const row = await requireRequest(env, id);
  if (row.status === 'approved' || row.status === 'rejected')
    throw new ApiError('CONFLICT', 409, 'This request is already closed');
  if (row.status === 'failed')
    throw new ApiError('CONFLICT', 409, 'Resolve the failed approval first');
  if (row.cloudflare_address_id) {
    return {
      email: row.email,
      verified: row.email_verified_at !== null,
      status: row.status,
      already_added: true,
    };
  }
  const existing = await findCfAddress(env, row.email);
  const address =
    existing ??
    ((await cf(env, '/addresses', {
      method: 'POST',
      body: JSON.stringify({ email: row.email }),
    })) as CfAddress);
  const addressId = typeof address.id === 'string' ? address.id : null;
  if (!addressId)
    throw new ApiError(
      'EMAIL_ROUTING_FAILED',
      502,
      'Cloudflare did not return an address id',
    );
  const verified = address.verified === true;
  const status: ShopRequestStatus = verified
    ? 'email_verified'
    : 'awaiting_email';
  const res = await env.DB.prepare(
    `UPDATE shop_requests
        SET cloudflare_address_id = ?2,
            email_verification_sent_at = COALESCE(email_verification_sent_at, ?3),
            email_checked_at = ?3,
            email_verified_at = CASE WHEN ?4 = 1 THEN COALESCE(email_verified_at, ?3) ELSE email_verified_at END,
            status = ?5,
            updated_at = ?3
      WHERE id = ?1 AND status NOT IN ('approved','rejected','approving')`,
  )
    .bind(id, addressId, now, verified ? 1 : 0, status)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    const current = await requireRequest(env, id);
    return {
      email: current.email,
      verified: current.email_verified_at !== null,
      status: current.status,
      already_added: false,
    };
  }
  await audit(env, {
    action: 'shop_request_email_added',
    requestId: id,
    operator,
    after: { email: row.email, verified, reused: existing !== null },
    now,
  });
  return { email: row.email, verified, status, already_added: false };
}

export async function checkRequestEmail(
  env: Env,
  id: string,
  operator: string,
  now = Date.now(),
): Promise<{
  email: string;
  verified: boolean;
  status: ShopRequestStatus;
  email_verified_at: number | null;
}> {
  const row = await requireRequest(env, id);
  if (!row.cloudflare_address_id)
    return {
      email: row.email,
      verified: false,
      status: row.status,
      email_verified_at: row.email_verified_at,
    };
  const address = (await cf(
    env,
    `/addresses/${encodeURIComponent(row.cloudflare_address_id)}`,
    { method: 'GET' },
  )) as CfAddress;
  const verified = address.verified === true;
  const status: ShopRequestStatus =
    row.status === 'approved' || row.status === 'rejected'
      ? row.status
      : verified
        ? 'email_verified'
        : 'awaiting_email';
  const res = await env.DB.prepare(
    `UPDATE shop_requests
        SET email_checked_at = ?2,
            email_verified_at = CASE WHEN ?3 = 1 THEN COALESCE(email_verified_at, ?2) ELSE email_verified_at END,
            status = ?4,
            updated_at = ?2
      WHERE id = ?1 AND status NOT IN ('approved','rejected','approving')`,
  )
    .bind(id, now, verified ? 1 : 0, status)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    const current = await requireRequest(env, id);
    return {
      email: current.email,
      verified: current.email_verified_at !== null,
      status: current.status,
      email_verified_at: current.email_verified_at,
    };
  }
  if (verified && row.email_verified_at === null)
    await audit(env, {
      action: 'shop_request_email_verified',
      requestId: id,
      operator,
      after: { email: row.email },
      now,
    });
  return {
    email: row.email,
    verified,
    status,
    email_verified_at: row.email_verified_at ?? (verified ? now : null),
  };
}

/**
 * Fallback used only when the Cloudflare API token is not configured. The operator must
 * have added and verified the address in the Cloudflare dashboard; the note is audited.
 */
export async function manualVerifyRequestEmail(
  env: Env,
  id: string,
  operator: string,
  note: string,
  now = Date.now(),
): Promise<void> {
  if (String(env.EMAIL_ROUTING_TOKEN ?? '').trim())
    throw new ApiError(
      'FORBIDDEN',
      403,
      'Cloudflare Email Routing is configured; use the verification check',
    );
  const row = await requireRequest(env, id);
  if (row.status === 'approved' || row.status === 'rejected')
    throw new ApiError('CONFLICT', 409, 'This request is already closed');
  const res = await env.DB.prepare(
    `UPDATE shop_requests
        SET email_verified_at = ?2, email_checked_at = ?2, status = 'email_verified', updated_at = ?2
      WHERE id = ?1 AND status NOT IN ('approved','rejected','approving')`,
  )
    .bind(id, now)
    .run();
  if ((res.meta.changes ?? 0) === 0)
    throw new ApiError(
      'CONFLICT',
      409,
      'This request is already being processed',
    );
  await audit(env, {
    action: 'shop_request_email_manual',
    requestId: id,
    operator,
    reason: note,
    after: { email: row.email },
    now,
  });
}

// ---- approval --------------------------------------------------------------------------------

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 22);
  return base.length >= 3 ? base : 'shop';
}

async function uniqueSlug(
  env: Env,
  name: string,
  now: number,
): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 8; i += 1) {
    const slug = `${base}-${newId(now).slice(-4).toLowerCase()}`.slice(0, 30);
    const taken = await env.DB.prepare('SELECT id FROM tenants WHERE slug = ?1')
      .bind(slug)
      .first();
    if (!taken) return slug;
  }
  return `shop-${newId(now).slice(-6).toLowerCase()}`.slice(0, 30);
}

async function defaultBranch(env: Env, tenantId: string): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT id FROM branches WHERE tenant_id = ?1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1',
  )
    .bind(tenantId)
    .first<{ id: string }>();
  if (!row)
    throw new ApiError('CONSTRAINT_FAILED', 409, 'The shop has no branch');
  return row.id;
}

async function issueOwnerCode(
  env: Env,
  tenantId: string,
  operator: string,
  now: number,
): Promise<{ code: string; expires_at: number }> {
  const branch = await defaultBranch(env, tenantId);
  const code = await enrolmentCodeStatement(env, tenantId, {
    device_name: 'Owner',
    branch_id: branch,
    grants_admin: true,
    created_by: `operator:${operator}`,
    now,
    ttl_ms: OWNER_CODE_TTL_MS,
  });
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM enrolment_codes WHERE tenant_id = ?1 AND grants_admin = 1 AND kind = 'till' AND used_at IS NULL",
    ).bind(tenantId),
    code.statement,
  ]);
  return { code: code.code, expires_at: code.expires_at };
}

export type ApproveResult = {
  request: ShopRequestRow;
  tenant: Awaited<ReturnType<typeof tenantById>>;
  owner_code: { code: string; expires_at: number; link: string } | null;
  invite_email_sent: boolean;
  already_approved: boolean;
};

export async function approveShopRequest(
  env: Env,
  id: string,
  operator: string,
  input: ApproveInput,
  now = Date.now(),
): Promise<ApproveResult> {
  let row = await requireRequest(env, id);
  if (row.status === 'approved' && row.tenant_id) {
    const tenant = await tenantById(env, row.tenant_id);
    return {
      request: row,
      tenant,
      owner_code: null,
      invite_email_sent: false,
      already_approved: true,
    };
  }
  if (row.status === 'rejected')
    throw new ApiError('CONFLICT', 409, 'This request was rejected');
  if (row.email_verified_at === null)
    throw new ApiError(
      'EMAIL_NOT_VERIFIED',
      409,
      'Verify the email before approving this request',
    );
  if (row.status !== 'email_verified' && row.status !== 'failed')
    throw new ApiError('CONFLICT', 409, 'This request is not ready to approve');

  const tenantId = row.tenant_id ?? row.claim_tenant_id ?? newId(now);
  let slug: string;
  if (input.slug) {
    slug = input.slug;
    const taken = await env.DB.prepare(
      'SELECT id FROM tenants WHERE slug = ?1 AND id <> ?2',
    )
      .bind(slug, tenantId)
      .first();
    if (taken) throw new ApiError('SLUG_TAKEN', 409, 'That slug is taken');
  } else {
    slug = await uniqueSlug(env, row.shop_name, now);
  }

  const claim = await env.DB.prepare(
    `UPDATE shop_requests
        SET status = 'approving', claim_tenant_id = ?2, reviewed_by = ?3, reviewed_at = ?4,
            last_error = '', updated_at = ?4
      WHERE id = ?1 AND status IN ('email_verified','failed')`,
  )
    .bind(id, tenantId, operator, now)
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    row = await requireRequest(env, id);
    if (row.status === 'approved' && row.tenant_id) {
      const tenant = await tenantById(env, row.tenant_id);
      return {
        request: row,
        tenant,
        owner_code: null,
        invite_email_sent: false,
        already_approved: true,
      };
    }
    throw new ApiError(
      'CONFLICT',
      409,
      'This request is already being processed',
    );
  }

  try {
    let tenant = await tenantById(env, tenantId);
    let ownerCode: { code: string; expires_at: number } | null = null;
    if (!tenant) {
      const created = await createTenant(
        env,
        {
          id: tenantId,
          slug,
          display_name: row.shop_name,
          owner_email: row.email,
          daily_write_budget: input.daily_write_budget ?? 18_000,
          note: [
            `Shop request from ${row.owner_name}`,
            row.phone,
            row.city,
            row.note,
            input.note ?? '',
          ]
            .filter(Boolean)
            .join(' · ')
            .slice(0, 500),
          created_by_email: operator,
        },
        now,
      );
      tenant = created.tenant;
      ownerCode = created.owner_code;
    } else {
      ownerCode = await issueOwnerCode(env, tenant.id, operator, now);
    }
    if (!tenant)
      throw new ApiError('APPROVAL_FAILED', 502, 'Tenant creation failed');

    await env.DB.prepare(
      `UPDATE shop_requests
          SET status = 'approved', tenant_id = ?2, claim_tenant_id = NULL, reviewed_by = ?3, reviewed_at = ?4, updated_at = ?4
        WHERE id = ?1`,
    )
      .bind(id, tenant.id, operator, now)
      .run();

    await audit(env, {
      action: 'shop_request_approve',
      requestId: id,
      tenantId: tenant.id,
      operator,
      after: { slug: tenant.slug, shop: tenant.display_name },
      now,
    });

    const db = tenantDb(env, { id: tenant.id, db_shard: tenant.db_shard });
    await db.batch(
      auditStatements(db, {
        action: 'shop_request_approved',
        entity: 'tenants',
        entityId: tenant.id,
        after: { request_id: id, operator },
        deviceId: 'server',
        staffId: 'server',
        now,
      }),
    );

    let inviteEmailSent = false;
    if (ownerCode) {
      const link = `${input.origin}${input.base_path}/enrol?code=${ownerCode.code.replace('-', '')}`;
      inviteEmailSent = await sendShopInviteEmail(env, row.email, {
        shopName: row.shop_name,
        code: ownerCode.code,
        link,
        expiresAt: ownerCode.expires_at,
      });
      row = (await requireRequest(env, id)) ?? row;
      return {
        request: row,
        tenant,
        owner_code: { ...ownerCode, link },
        invite_email_sent: inviteEmailSent,
        already_approved: false,
      };
    }
    return {
      request: (await requireRequest(env, id)) ?? row,
      tenant,
      owner_code: null,
      invite_email_sent: false,
      already_approved: false,
    };
  } catch (error) {
    const message =
      error instanceof SlugTakenError
        ? 'That slug is taken'
        : error instanceof ApiError
          ? error.message
          : 'Approval failed';
    await env.DB.prepare(
      `UPDATE shop_requests SET status = 'failed', last_error = ?2, updated_at = ?3 WHERE id = ?1`,
    )
      .bind(id, message.slice(0, 200), now)
      .run();
    if (error instanceof SlugTakenError)
      throw new ApiError('SLUG_TAKEN', 409, 'That slug is taken');
    if (error instanceof ApiError) throw error;
    throw new ApiError('APPROVAL_FAILED', 502, 'Approval failed');
  }
}

export async function rejectShopRequest(
  env: Env,
  id: string,
  operator: string,
  reason: string,
  now = Date.now(),
): Promise<ShopRequestRow> {
  const result = await env.DB.prepare(
    `UPDATE shop_requests
        SET status = 'rejected', reject_reason = ?2, reviewed_by = ?3, reviewed_at = ?4, updated_at = ?4
      WHERE id = ?1 AND status IN ('pending','awaiting_email','email_verified','failed')`,
  )
    .bind(id, reason.slice(0, 200), operator, now)
    .run();
  if ((result.meta.changes ?? 0) !== 1)
    throw new ApiError('CONFLICT', 409, 'This request cannot be rejected now');
  await audit(env, {
    action: 'shop_request_reject',
    requestId: id,
    operator,
    reason,
    now,
  });
  return requireRequest(env, id);
}

export async function reopenShopRequest(
  env: Env,
  id: string,
  operator: string,
  reason: string,
  now = Date.now(),
): Promise<ShopRequestRow> {
  const row = await requireRequest(env, id);
  if (row.status !== 'rejected')
    throw new ApiError(
      'CONFLICT',
      409,
      'Only a rejected request can be reopened',
    );
  const next = row.email_verified_at !== null ? 'email_verified' : 'pending';
  await env.DB.prepare(
    `UPDATE shop_requests
        SET status = ?2, reject_reason = '', reviewed_by = ?3, reviewed_at = ?4, updated_at = ?4
      WHERE id = ?1`,
  )
    .bind(id, next, operator, now)
    .run();
  await audit(env, {
    action: 'shop_request_reopen',
    requestId: id,
    operator,
    reason,
    now,
  });
  return requireRequest(env, id);
}
