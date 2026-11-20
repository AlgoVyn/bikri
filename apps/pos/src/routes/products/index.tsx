import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/products/')({
  component: lazyRouteComponent(
    () => import('../../products/ProductWorkspace.tsx'),
    'ProductWorkspace',
  ),
});
