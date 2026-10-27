/** `GET /api/me` (04 §3.3): device code moves, status, support, poll interval. */
import type { BikriDb } from '@bikri/db';
import { setKv } from '../data/kv.ts';
import { type DeviceInfo, deviceInfo } from '../data/localTenant.ts';
import { tillRequest } from './client.ts';
import { applyStatus, type StatusPayload } from './status.ts';

export type MeResponse = {
  tenant: { id: string; display_name: string; status: string };
  device: {
    id: string;
    name: string;
    branch_id: string;
    device_code: string;
    is_admin: boolean;
    last_invoice_seq: number;
  };
  shop_setup_completed: boolean;
  server_time: number;
} & StatusPayload;

export async function refreshMe(db: BikriDb): Promise<MeResponse> {
  const me = await tillRequest<MeResponse>(db, '/me');
  await applyStatus(db, me);
  const local = await deviceInfo(db);
  const next: DeviceInfo = {
    id: me.device.id,
    name: me.device.name,
    code: me.device.device_code,
    branch_id: me.device.branch_id,
    is_admin: me.device.is_admin,
  };
  if (JSON.stringify(local) !== JSON.stringify(next))
    await setKv(db, 'device', next);
  return me;
}
