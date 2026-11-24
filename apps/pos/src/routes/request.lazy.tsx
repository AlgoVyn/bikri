import { createLazyFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../components/PageLoading.tsx';

/**
 * The shop-request pages and their catalogs are online-only and excluded from the
 * offline precache, so this route imports the page lazily. A static import made the
 * whole router chunk depend on `assets/public/*`: one failed request for that
 * online-only chunk then broke every shop route (D-299).
 */
const RequestShopPage = lazy(() =>
  import('../public/RequestShopPage.tsx').then((module) => ({
    default: module.RequestShopPage,
  })),
);

export const Route = createLazyFileRoute('/request')({
  component: RequestRoute,
});

function RequestRoute() {
  return (
    <Suspense fallback={<PageLoading />}>
      <RequestShopPage />
    </Suspense>
  );
}
