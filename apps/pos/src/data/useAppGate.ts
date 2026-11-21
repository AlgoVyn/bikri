import type { BikriDb } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { getDb, NoActiveTenantError } from './db.ts';
import { ensureLocalTenant } from './localTenant.ts';
import { isSetupDone } from './setup.ts';
import { DEV_TENANT_ID } from './tenant.ts';

export type AppGate = 'loading' | 'enrol' | 'setup' | 'ready';

/** Pure gate decision, separated so the interrupted-download/cleared-DB cases are testable. */
export function appGate(input: {
  done: boolean;
  enrolled: boolean;
  devTenant: boolean;
  setupCompleted: boolean;
  /** Enrolment is still downloading its first snapshot (SYNC-H4). */
  initialSyncPending?: boolean;
}): AppGate {
  if (!input.enrolled && !input.devTenant) return 'enrol';
  // The enrol page owns the download it started. Leaving `enrol` while it runs would
  // unmount the progress/retry UI and either start a competing sync engine or redirect
  // to setup with an empty database.
  if (input.initialSyncPending) return 'enrol';
  if (input.done) return 'ready';
  // An enrolled live shop is still downloading its first snapshot: keep waiting (the
  // sync engine resumes it) instead of sending the owner through setup again.
  if (input.enrolled && input.setupCompleted) return 'loading';
  return 'setup';
}

/** Which top-level screen the till may show: enrol (T-034), the setup wizard, or the app. */
export type GateInfo = {
  gate: AppGate;
  db: BikriDb | null;
  /** The owner revoked this device (03 §8): show the enrol screen with the revoked notice. */
  revoked: boolean;
  /** This browser holds a device token for the open shop. */
  enrolled: boolean;
  /** The enrolment's first snapshot is still downloading (SYNC-H4). */
  initialSyncPending: boolean;
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
    const [token, revoked, tenant, setup, pending] = await Promise.all([
      db.kv.get('device_token'),
      db.kv.get('revoked'),
      db.kv.get('tenant'),
      db.kv.get('shop_setup_completed'),
      db.kv.get('initial_sync_pending'),
    ]);
    return {
      enrolled: Boolean(token?.value),
      revoked: Boolean(revoked?.value),
      setupCompleted: setup?.value === true,
      initialSyncPending: pending?.value === true,
      shopName:
        (tenant?.value as { display_name?: string } | undefined)
          ?.display_name ?? null,
    };
  }, [db]);
  const none = {
    revoked: false,
    enrolled: false,
    setupCompleted: false,
    initialSyncPending: false,
    shopName: null,
  };
  if (noTenant) return { gate: 'enrol', db: null, ...none };
  if (!db || done === undefined || device === undefined)
    return { gate: 'loading', db, ...none };
  return {
    gate: appGate({
      done,
      enrolled: device.enrolled,
      devTenant: db.tenantId === DEV_TENANT_ID,
      setupCompleted: device.setupCompleted,
      initialSyncPending: device.initialSyncPending,
    }),
    db,
    ...device,
  };
}
