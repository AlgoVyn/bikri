import { createRootRoute, Outlet } from '@tanstack/react-router';
import { ToastProvider } from '../components/Toast.tsx';
import { AppShell } from '../shell/AppShell.tsx';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <ToastProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </ToastProvider>
  );
}
