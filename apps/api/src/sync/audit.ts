import { newId } from '@bikri/core';
import type { TenantDb } from '../db/tenantDb.ts';
import { changeLogStatement } from './changeLog.ts';

export type AuditInput = {
  action: string;
  entity?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  /** Device that acted, or 'server' (operator, cron). */
  deviceId?: string;
  /** Staff that acted; default = the shop's first owner, or 'server' before setup (13 §7.2). */
  staffId?: string;
  now: number;
};

/** An `audit_log` row in the tenant plus its `change_log` row, so it syncs to the tills. */
export function auditStatements(
  db: TenantDb,
  input: AuditInput,
): D1PreparedStatement[] {
  const id = newId(input.now);
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  const insert = input.staffId
    ? db.prepare(
        'INSERT INTO audit_log (tenant_id, id, action, entity, entity_id, before_json, after_json, device_id, staff_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
        id,
        input.action,
        input.entity ?? 'shop',
        input.entityId ?? 'shop',
        json(input.before),
        json(input.after),
        input.deviceId ?? 'server',
        input.staffId,
        input.now,
      )
    : db.prepare(
        "INSERT INTO audit_log (tenant_id, id, action, entity, entity_id, before_json, after_json, device_id, staff_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE((SELECT id FROM staff WHERE tenant_id = ?1 AND role = 'owner' AND deleted_at IS NULL ORDER BY created_at LIMIT 1), 'server'), ?9)",
        id,
        input.action,
        input.entity ?? 'shop',
        input.entityId ?? 'shop',
        json(input.before),
        json(input.after),
        input.deviceId ?? 'server',
        input.now,
      );
  return [
    insert,
    changeLogStatement(db, 'audit_log', id, 'upsert', null, input.now),
  ];
}
