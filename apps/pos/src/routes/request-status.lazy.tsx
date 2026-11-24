import { createLazyFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../components/PageLoading.tsx';

// Online-only page under `assets/public/`; keep it out of the router chunk's
// static imports so the offline graph never depends on it (D-299).
const RequestStatusPage = lazy(() =>
  import('../public/RequestStatusPage.tsx').then((module) => ({
    default: module.RequestStatusPage,
  })),
);

export const Route = createLazyFileRoute('/request-status')({
  component: RequestStatusRoute,
});

function RequestStatusRoute() {
  return (
    <Suspense fallback={<PageLoading />}>
      <RequestStatusPage />
    </Suspense>
  );
}
