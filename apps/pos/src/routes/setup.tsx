import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/setup')({
  component: lazyRouteComponent(
    () => import('../setup/SetupWizard.tsx'),
    'SetupWizard',
  ),
});
