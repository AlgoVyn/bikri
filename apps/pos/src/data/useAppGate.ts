import type { BikriDb } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { getDb, NoActiveTenantError } from './db.ts';
import { ensureLocalTenant } from './localTenant.ts';
import { isSetupDone } from './setup.ts';

export type AppGate = 'loading' | 'enrol' | 'setup' | 'ready';

/** Which top-level screen the till may show: enrol (T-034), the setup wizard, or the app. */
export type GateInfo = {
  gate: AppGate;
  db: BikriDb | null;
  /** The owner revoked this device (03 §8): show the enrol screen with the revoked notice. */
  revoked: boolean;
  /** This browser holds a device token for the open shop. */
  enrolled: boolean;
  shopName: string | null;
};

export function useAppGate(): GateInfo {
  const [db, setDb] = useState<BikriDb | null>(null);
  const [noTenant, setNoTenant] = useState(false);
  useEffect(() => {
    try {
      const opened = getDb();
      void ensureLocalTenant(opened).then(() => setDb(opened));
    } catch (error) {
      if (!(error instanceof NoActiveTenantError)) throw error;
      setNoTenant(true);
    }
  }, []);
  const done = useLiveQuery(
    async () => (db ? isSetupDone(db) : undefined),
    [db],
  );
  const device = useLiveQuery(async () => {
    if (!db) return undefined;
    const [token, revoked, tenant] = await Promise.all([
      db.kv.get('device_token'),
      db.kv.get('revoked'),
      db.kv.get('tenant'),
    ]);
    return {
      enrolled: Boolean(token?.value),
      revoked: Boolean(revoked?.value),
      shopName:
        (tenant?.value as { display_name?: string } | undefined)
          ?.display_name ?? null,
    };
  }, [db]);
  const none = { revoked: false, enrolled: false, shopName: null };
  if (noTenant) return { gate: 'enrol', db: null, ...none };
  if (!db || done === undefined || device === undefined)
    return { gate: 'loading', db, ...none };
  return { gate: done ? 'ready' : 'setup', db, ...device };
}
