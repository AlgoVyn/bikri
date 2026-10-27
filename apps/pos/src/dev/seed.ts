import { hashPin } from '@bikri/core';
import { deleteTenantDb } from '@bikri/db';
import { closeDb, getDb } from '../data/db.ts';
import { ensureLocalTenant } from '../data/localTenant.ts';
import { finishSetup } from '../data/setup.ts';

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
