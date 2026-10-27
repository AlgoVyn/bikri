import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/shop')({
  component: lazyRouteComponent(
    () => import('../../settings/ShopSettingsPage.tsx'),
    'ShopSettingsPage',
  ),
});
