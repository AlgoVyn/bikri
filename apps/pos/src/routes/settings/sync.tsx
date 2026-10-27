import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/sync')({
  component: lazyRouteComponent(
    () => import('../../settings/SyncPage.tsx'),
    'SyncPage',
  ),
});
