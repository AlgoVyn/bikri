import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../../components/PageLoading.tsx';

const StockCountPage = lazy(() =>
  import('../../products/StockCount.tsx').then((module) => ({
    default: module.StockCountPage,
  })),
);

export const Route = createFileRoute('/stock/count')({
  component: StockCountRoute,
});

function StockCountRoute() {
  return (
    <Suspense fallback={<PageLoading compact />}>
      <StockCountPage />
    </Suspense>
  );
}
