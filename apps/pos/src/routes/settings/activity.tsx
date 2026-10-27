import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/activity')({
  component: lazyRouteComponent(
    () => import('../../settings/ActivityPage.tsx'),
    'ActivityPage',
  ),
});
