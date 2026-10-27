import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/devices')({
  component: lazyRouteComponent(
    () => import('../../settings/DevicesPage.tsx'),
    'DevicesPage',
  ),
});
