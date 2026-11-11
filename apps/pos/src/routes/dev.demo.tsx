import { createFileRoute, redirect } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../components/PageLoading.tsx';

const DemoPage = import.meta.env.DEV
  ? lazy(() => import('../dev/DemoPage.tsx'))
  : null;

/**
 * Dev-only shortcut: reset the local dev shop and load the demo catalogue, then reload
 * into Sell. Open `/bikri/dev/demo` directly or use "Load demo data" in a dev build.
 */
export const Route = createFileRoute('/dev/demo')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw redirect({ to: '/' });
  },
  component: DevDemoPage,
});

function DevDemoPage() {
  if (DemoPage === null) return null;
  return (
    <Suspense fallback={<PageLoading />}>
      <DemoPage />
    </Suspense>
  );
}
