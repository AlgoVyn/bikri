import {
  createRootRoute,
  Navigate,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ToastProvider } from '../components/Toast.tsx';
import { useAppGate } from '../data/useAppGate.ts';
import { AppShell } from '../shell/AppShell.tsx';
import { useSession } from '../state/session.ts';
import { SyncEngine } from '../sync/engine.ts';

export const Route = createRootRoute({
  component: RootLayout,
});

const EnrolPage = lazy(() =>
  import('../enrol/EnrolPage.tsx').then((m) => ({ default: m.EnrolPage })),
);

function Gate() {
  const { t } = useTranslation();
  const { gate, db, revoked, enrolled, shopName } = useAppGate();
  // T-033/T-036: sync runs whenever this browser holds a device token for the open shop.
  useEffect(() => {
    if (!db || !enrolled || revoked) return;
    let engine: SyncEngine | null = null;
    let cancelled = false;
    void SyncEngine.start(db).then((e) => {
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
  const devUi = pathname.startsWith('/dev/');
  if (gate === 'loading')
    return <p className="sr-only">{t('common.loading')}</p>;
  const onEnrol = pathname === '/enrol' || pathname === '/enrol/';
  if (gate === 'enrol' || revoked || onEnrol)
    return (
      <Suspense fallback={<p className="sr-only">{t('common.loading')}</p>}>
        <EnrolPage
          db={enrolled || revoked ? db : null}
          shopName={shopName}
          revoked={revoked}
        />
      </Suspense>
    );
  if (gate === 'setup' && !onSetup && !devUi)
    return <Navigate to="/setup" replace />;
  // Finishing the wizard flips the gate to 'ready' while still on /setup: go where Finish asked.
  if (gate === 'ready' && onSetup) return <Navigate to={afterSetup} replace />;
  if (onSetup) return <Outlet />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function RootLayout() {
  return (
    <ToastProvider>
      <Gate />
    </ToastProvider>
  );
}
