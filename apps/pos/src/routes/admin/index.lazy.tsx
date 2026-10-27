import { createLazyFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '../../admin/OverviewPage.tsx';

export const Route = createLazyFileRoute('/admin/')({
  component: OverviewPage,
});
