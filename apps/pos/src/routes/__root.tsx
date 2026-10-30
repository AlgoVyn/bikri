import {
  createRootRoute,
  Navigate,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { MoneyGroupingProvider } from '../components/MoneyGrouping.tsx';
import { PageLoading } from '../components/PageLoading.tsx';
import { ToastProvider } from '../components/Toast.tsx';
import { useAppGate } from '../data/useAppGate.ts';
import { useAutoLock } from '../lock/autoLock.ts';
import { AppShell } from '../shell/AppShell.tsx';
import { useSession } from '../state/session.ts';
import type { SyncEngine } from '../sync/engine.ts';

export const Route = createRootRoute({
  component: RootLayout,
});

const LockScreen = lazy(() =>
  import('../lock/LockScreen.tsx').then((m) => ({ default: m.LockScreen })),
);

const EnrolPage = lazy(() =>
  import('../enrol/EnrolPage.tsx').then((m) => ({ default: m.EnrolPage })),
);

function Gate() {
  const { gate, db, revoked, enrolled, shopName } = useAppGate();
  const session = useSession((s) => s.session);
  // T-035: an enrolled shop starts locked; the local dev/e2e shop keeps acting as owner (D-090).
  useAutoLock(enrolled && !revoked);
  // T-033/T-036: sync runs whenever this browser holds a device token for the open shop.
  useEffect(() => {
    if (!db || !enrolled || revoked) return;
    let engine: SyncEngine | null = null;
    let cancelled = false;
    void import('../sync/engine.ts')
      .then((m) => m.SyncEngine.start(db))
      .then((e) => {
        if (cancelled) e?.stop();
        else engine = e;
      });
    return () => {
      cancelled = true;
      engine?.stop();
    };
  }, [db, enrolled, revoked]);
  const afterSetup = useSession((s) => s.afterSetup);
  const { pathname } = useLocation();
  const onSetup = pathname === '/setup' || pathname === '/setup/';
  const devUi = import.meta.env.DEV && pathname.startsWith('/dev/');
  if (gate === 'loading') return <PageLoading />;
  const onEnrol = pathname === '/enrol' || pathname === '/enrol/';
  if (gate === 'enrol' || revoked || onEnrol)
    return (
      <Suspense fallback={<PageLoading />}>
        <EnrolPage
          db={enrolled || revoked ? db : null}
          shopName={shopName}
          revoked={revoked}
        />
      </Suspense>
    );
  if (gate === 'ready' && enrolled && !session && !devUi)
    return (
      <Suspense fallback={<PageLoading />}>
        <LockScreen />
      </Suspense>
    );
  if (gate === 'setup' && !onSetup && !devUi)
    return <Navigate to="/setup" replace />;
  // Finishing the wizard flips the gate to 'ready' while still on /setup: go where Finish asked.
  if (gate === 'ready' && onSetup) return <Navigate to={afterSetup} replace />;
  if (onSetup) return <Outlet />;
  return (
    <MoneyGroupingProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </MoneyGroupingProvider>
  );
}

function RootLayout() {
  const { pathname } = useLocation();
  // The operator console never opens a shop database or the PIN lock (screens/19).
  const admin = pathname === '/admin' || pathname.startsWith('/admin/');
  return <ToastProvider>{admin ? <Outlet /> : <Gate />}</ToastProvider>;
}
