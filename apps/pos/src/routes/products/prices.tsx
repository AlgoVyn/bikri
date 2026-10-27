import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/products/prices')({
  component: lazyRouteComponent(
    () => import('../../products/PricesPage.tsx'),
    'PricesPage',
  ),
});
