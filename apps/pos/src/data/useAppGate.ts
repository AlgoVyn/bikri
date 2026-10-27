import type { BikriDb } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { getDb, NoActiveTenantError } from './db.ts';
import { ensureLocalTenant } from './localTenant.ts';
import { isSetupDone } from './setup.ts';

export type AppGate = 'loading' | 'enrol' | 'setup' | 'ready';

/** Which top-level screen the till may show: enrol (T-034), the setup wizard, or the app. */
export function useAppGate(): { gate: AppGate; db: BikriDb | null } {
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
  if (noTenant) return { gate: 'enrol', db: null };
  if (!db || done === undefined) return { gate: 'loading', db };
  return { gate: done ? 'ready' : 'setup', db };
}
