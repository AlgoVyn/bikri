import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/products/import')({
  component: lazyRouteComponent(
    () => import('../../products/ImportPage.tsx'),
    'ImportPage',
  ),
});
