import { nextDeviceCode } from '../auth/deviceCodes.ts';
import type { TenantDb } from '../db/tenantDb.ts';
import type { DeviceRow } from '../types.ts';

/**
 * Next device code in a branch: after every code in the branch registry and every code a
 * branch device still carries. The registry is backfilled once from invoice numbers; this
 * used to fetch and regex-parse every bill in the branch on each enrolment.
 */
export async function allocateDeviceCode(
  db: TenantDb,
  branchId: string,
): Promise<string> {
  const [registry, devices] = await db.batch([
    db.prepare(
      'SELECT device_code FROM branch_device_codes WHERE tenant_id = ?1 AND branch_id = ?2',
      branchId,
    ),
    db.prepare(
      'SELECT device_code, device_code_history FROM devices WHERE tenant_id = ?1 AND branch_id = ?2',
      branchId,
    ),
  ]);
  const used: string[] = [];
  for (const r of (registry?.results ?? []) as { device_code: string }[])
    used.push(r.device_code);
  for (const r of (devices?.results ?? []) as {
    device_code: string;
    device_code_history: string;
  }[]) {
    used.push(r.device_code);
    used.push(
      ...String(r.device_code_history ?? '')
        .split(',')
        .filter(Boolean),
    );
  }
  const code = nextDeviceCode(used);
  // Reserve the code even if the device write later fails; a code is never reused.
  await db.run(
    'INSERT OR IGNORE INTO branch_device_codes (tenant_id, branch_id, device_code) VALUES (?1, ?2, ?3)',
    branchId,
    code,
  );
  return code;
}

/** The device as a till sees it (04 §3.2–3.3). */
export function publicDevice(device: DeviceRow) {
  return {
    id: device.id,
    name: device.name,
    branch_id: device.branch_id,
    device_code: device.device_code,
    is_admin: device.is_admin === 1,
    kind: device.kind,
    revoked: device.revoked_at !== null,
    last_invoice_seq: device.last_invoice_seq,
  };
}
