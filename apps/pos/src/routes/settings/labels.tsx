import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/labels')({
  component: lazyRouteComponent(
    () => import('../../settings/LabelsPage.tsx'),
    'LabelsPage',
  ),
});
