import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/printer')({
  component: lazyRouteComponent(
    () => import('../../settings/PrinterPage.tsx'),
    'PrinterPage',
  ),
});
