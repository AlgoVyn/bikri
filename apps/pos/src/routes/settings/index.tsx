import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/')({
  component: lazyRouteComponent(
    () => import('../../settings/SettingsHomePage.tsx'),
    'SettingsHomePage',
  ),
});
