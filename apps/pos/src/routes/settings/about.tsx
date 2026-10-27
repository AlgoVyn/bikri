import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/about')({
  component: lazyRouteComponent(
    () => import('../../settings/AboutPage.tsx'),
    'AboutPage',
  ),
});
