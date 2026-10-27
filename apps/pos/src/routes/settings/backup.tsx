import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/backup')({
  component: lazyRouteComponent(
    () => import('../../settings/BackupPage.tsx'),
    'BackupPage',
  ),
});
