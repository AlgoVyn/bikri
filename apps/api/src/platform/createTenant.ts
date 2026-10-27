/** Tenant creation in one batch (02 §2.1, 13 §7.1). */
import { newId } from '@bikri/core';
import { codeHash, newEnrolmentCode, normaliseCode } from '../auth/crypto.ts';
import { tenantDb } from '../db/tenantDb.ts';
import { changeLogStatement } from '../sync/changeLog.ts';
import type { TenantRow } from '../types.ts';

export const OWNER_CODE_TTL_MS = 72 * 3600_000;
export const TILL_CODE_TTL_MS = 15 * 60_000;

export type NewTenant = {
  slug: string;
  display_name: string;
  owner_email: string | null;
  daily_write_budget: number;
  note: string;
  created_by_email: string;
};

export type IssuedCode = { code: string; expires_at: number; link: string };

export function enrolLink(
  origin: string,
  basePath: string,
  code: string,
): string {
  return `${origin}${basePath}/enrol?code=${code.replace('-', '')}`;
}

/** Statement that stores an enrolment code (hash only) and the plain code to show once. */
export async function enrolmentCodeStatement(
  env: Env,
  tenantId: string,
  input: {
    device_name: string;
    branch_id: string;
    grants_admin: boolean;
    kind?: 'till' | 'support';
    created_by: string;
    now: number;
    ttl_ms: number;
  },
): Promise<{
  statement: D1PreparedStatement;
  code: string;
  expires_at: number;
}> {
  const code = newEnrolmentCode();
  const hash = await codeHash(normaliseCode(code) ?? '');
  const expires = input.now + input.ttl_ms;
  const db = tenantDb(env, { id: tenantId, db_shard: 'DB' });
  return {
    code,
    expires_at: expires,
    statement: db.prepare(
      'INSERT INTO enrolment_codes (tenant_id, code_hash, device_name, branch_id, grants_admin, kind, created_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
      hash,
      input.device_name,
      input.branch_id,
      input.grants_admin ? 1 : 0,
      input.kind ?? 'till',
      input.created_by,
      input.now,
      expires,
    ),
  };
}

export class SlugTakenError extends Error {}

/** Creates the tenant, its default branch, expense categories, change_log rows and owner code. */
export async function createTenant(
  env: Env,
  input: NewTenant,
  now = Date.now(),
): Promise<{
  tenant: TenantRow;
  owner_code: { code: string; expires_at: number };
}> {
  const taken = await env.DB.prepare('SELECT id FROM tenants WHERE slug = ?1')
    .bind(input.slug)
    .first();
  if (taken) throw new SlugTakenError(input.slug);
  const id = newId(now);
  const branchId = newId(now);
  const db = tenantDb(env, { id, db_shard: 'DB' });
  const templates = await env.DB.prepare(
    'SELECT code FROM expense_category_templates ORDER BY sort_order',
  ).all<{ code: string }>();
  const owner = await enrolmentCodeStatement(env, id, {
    device_name: 'Owner',
    branch_id: branchId,
    grants_admin: true,
    created_by: `operator:${input.created_by_email}`,
    now,
    ttl_ms: OWNER_CODE_TTL_MS,
  });
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO tenants (id, slug, display_name, owner_email, daily_write_budget, note, restore_epoch, created_by_email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)',
    ).bind(
      id,
      input.slug,
      input.display_name,
      input.owner_email,
      input.daily_write_budget,
      input.note,
      String(now),
      input.created_by_email,
      now,
    ),
    db.prepare(
      "INSERT INTO branches (tenant_id, id, name, bill_prefix, is_default, created_at, updated_at, updated_by) VALUES (?1, ?2, 'Main', 'INV', 1, ?3, ?3, 'server')",
      branchId,
      now,
    ),
    db.prepare(
      'INSERT INTO expense_categories (tenant_id, id, code, name_en, name_ur, icon, is_system, sort_order, created_at, updated_at) SELECT ?1, code, code, name_en, name_ur, icon, 1, sort_order, 0, 0 FROM expense_category_templates',
    ),
    changeLogStatement(db, 'branches', branchId, 'upsert', null, now),
    ...templates.results.map((t) =>
      changeLogStatement(db, 'expense_categories', t.code, 'upsert', null, now),
    ),
    owner.statement,
  ]);
  const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?1')
    .bind(id)
    .first<TenantRow>();
  if (!tenant) throw new Error('tenant row missing after create');
  return {
    tenant,
    owner_code: { code: owner.code, expires_at: owner.expires_at },
  };
}
