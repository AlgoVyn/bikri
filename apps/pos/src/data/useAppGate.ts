import type { BikriDb } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
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
  // Open the cached tenant database during the first render, not after an effect tick:
  // the gate can start its setup/status reads immediately and the app does not flash a
  // loading screen while the event loop delivers an already-available Dexie handle.
  const [initial] = useState<{ db: BikriDb | null; noTenant: boolean }>(() => {
    try {
      return { db: getDb(), noTenant: false };
    } catch (error) {
      if (!(error instanceof NoActiveTenantError)) throw error;
      return { db: null, noTenant: true };
    }
  });
  const { db, noTenant } = initial;
  // The dev shop's stand-in rows are still created asynchronously on first launch; every
  // enrolled shop is ready as soon as getDb() returns.
  const [ready, setReady] = useState(
    () => db === null || db.tenantId !== DEV_TENANT_ID,
  );
  useEffect(() => {
    if (!db || db.tenantId !== DEV_TENANT_ID) return;
    let live = true;
    void ensureLocalTenant(db)
      .catch(() => undefined)
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, [db]);
  const done = useLiveQuery(
    async () => (db && ready ? isSetupDone(db) : undefined),
    [db, ready],
  );
  const device = useLiveQuery(async () => {
    if (!db || !ready) return undefined;
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
  }, [db, ready]);
  const gate: AppGate = noTenant
    ? 'enrol'
    : !db || !ready || done === undefined || device === undefined
      ? 'loading'
      : appGate({
          done,
          enrolled: device.enrolled,
          devTenant: db.tenantId === DEV_TENANT_ID,
          setupCompleted: device.setupCompleted,
          initialSyncPending: device.initialSyncPending,
        });
  const revoked = !noTenant && device?.revoked === true;
  const enrolled = !noTenant && device?.enrolled === true;
  const initialSyncPending = !noTenant && device?.initialSyncPending === true;
  const shopName = noTenant ? null : (device?.shopName ?? null);
  // `db.kv` emits a fresh object on every write (sync timestamps, invoice counters).
  // Keep the gate value stable unless one of its fields actually changed, so a kv
  // write does not invalidate every consumer of this hook.
  return useMemo(
    () => ({
      gate,
      db: noTenant ? null : db,
      revoked,
      enrolled,
      initialSyncPending,
      shopName,
    }),
    [gate, db, noTenant, revoked, enrolled, initialSyncPending, shopName],
  );
}
