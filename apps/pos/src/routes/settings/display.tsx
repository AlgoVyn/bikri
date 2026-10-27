import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/display')({
  component: lazyRouteComponent(
    () => import('../../settings/DisplayPage.tsx'),
    'DisplayPage',
  ),
});
