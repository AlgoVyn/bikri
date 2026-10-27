import {
  createRootRoute,
  Navigate,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { ToastProvider } from '../components/Toast.tsx';
import { useAppGate } from '../data/useAppGate.ts';
import { AppShell } from '../shell/AppShell.tsx';

export const Route = createRootRoute({
  component: RootLayout,
});

function Gate() {
  const { t } = useTranslation();
  const { gate } = useAppGate();
  const { pathname } = useLocation();
  const onSetup = pathname === '/setup' || pathname === '/setup/';
  const devUi = pathname.startsWith('/dev/');
  if (gate === 'loading')
    return <p className="sr-only">{t('common.loading')}</p>;
  if (gate === 'enrol')
    return (
      <EmptyState heading={t('common.app_name')} message={t('enrol.needed')} />
    );
  if (gate === 'setup' && !onSetup && !devUi)
    return <Navigate to="/setup" replace />;
  if (gate === 'ready' && onSetup) return <Navigate to="/" replace />;
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
