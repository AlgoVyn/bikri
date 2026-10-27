import { codeOfInvoice, nextDeviceCode } from '../auth/deviceCodes.ts';
import type { TenantDb } from '../db/tenantDb.ts';
import type { DeviceRow } from '../types.ts';

/**
 * Next device code in a branch: after every code a device of that branch has, or that appears in
 * the branch's invoice numbers (a device moved away keeps its old bills), so codes are never
 * reused (04 §3.8).
 */
export async function allocateDeviceCode(
  db: TenantDb,
  branchId: string,
): Promise<string> {
  const [devices, invoices] = await db.batch([
    db.prepare(
      'SELECT device_code FROM devices WHERE tenant_id = ?1 AND branch_id = ?2',
      branchId,
    ),
    db.prepare(
      'SELECT MAX(invoice_no) AS invoice_no FROM sales WHERE tenant_id = ?1 AND branch_id = ?2 GROUP BY device_id',
      branchId,
    ),
  ]);
  const used: string[] = [];
  for (const r of (devices?.results ?? []) as { device_code: string }[])
    used.push(r.device_code);
  for (const r of (invoices?.results ?? []) as { invoice_no: string }[]) {
    const code = codeOfInvoice(r.invoice_no);
    if (code) used.push(code);
  }
  return nextDeviceCode(used);
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
