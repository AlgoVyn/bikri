import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/stock/count')({
  component: lazyRouteComponent(
    () => import('../../products/StockCount.tsx'),
    'StockCountPage',
  ),
});
