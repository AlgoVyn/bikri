import { createLazyFileRoute } from '@tanstack/react-router';
import { RequestsPage } from '../../../admin/RequestsPage.tsx';

export const Route = createLazyFileRoute('/admin/requests/')({
  component: RequestsPage,
});
