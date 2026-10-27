import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/labels')({
  component: lazyRouteComponent(
    () => import('../labels/LabelsRoutePage.tsx'),
    'LabelsRoutePage',
  ),
});
