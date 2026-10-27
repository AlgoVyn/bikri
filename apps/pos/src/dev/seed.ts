import { businessDate, hashPin, newId } from '@bikri/core';
import { deleteTenantDb } from '@bikri/db';
import { closeDb, getDb } from '../data/db.ts';
import { ensureLocalTenant } from '../data/localTenant.ts';
import { finishSetup } from '../data/setup.ts';
import { useSession } from '../state/session.ts';
import { seedSampleDay } from './sampleDay.ts';

/** Fresh `bikri-dev` database with a finished setup wizard (owner PIN 4826). */
export async function seedReadyShop(): Promise<void> {
  closeDb();
  await deleteTenantDb('dev');
  const db = getDb();
  await ensureLocalTenant(db);
  await finishSetup(
    db,
    {
      shop: {
        name: 'Algovyn Mobiles',
        business_type: 'mobile',
        phone: '+923001234567',
        address: 'Hall Road, Lahore',
        city: '',
        ntn: '',
        strn: '',
      },
      owner: { name: 'Adnan', pin: '4826' },
      receipt: {
        header: '',
        footer: '',
        tax_rate_bp: 0,
        inclusive: false,
        round_total_to: 100,
      },
      product: null,
    },
    { pinHash: await hashPin('4826', 1000) },
  );
}

export async function resetDevDb(): Promise<void> {
  closeDb();
  await deleteTenantDb('dev');
}

/** Unlocks the till as a new staff member of `role` (stands in for the PIN lock until T-035). */
export async function unlockAs(
  role: 'owner' | 'manager' | 'cashier',
  name = 'Sana',
): Promise<string> {
  const db = getDb();
  const id = newId();
  const now = Date.now();
  await db.staff.add({
    id,
    name,
    role,
    pin_hash: '',
    pin_salt: '',
    pin_iterations: 0,
    active: 1,
    permissions_json: '{}',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    rev: 0,
  });
  useSession.getState().unlock({ staff_id: id, role, unlocked_at: now });
  return id;
}

/** seedSampleDay on today's business date in the dev shop. */
export async function seedTodaySales(): Promise<void> {
  await seedSampleDay(getDb(), businessDate(Date.now()));
}
