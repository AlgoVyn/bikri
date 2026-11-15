import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/sell')({
  component: lazyRouteComponent(
    () => import('../sell/SellPage.tsx'),
    'SellPage',
  ),
});
