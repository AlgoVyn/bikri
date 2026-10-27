import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/cashiers')({
  component: lazyRouteComponent(
    () => import('../../settings/StaffSettingsPage.tsx'),
    'StaffSettingsPage',
  ),
});
