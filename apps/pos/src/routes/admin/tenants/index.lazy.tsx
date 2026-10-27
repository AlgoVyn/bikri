import { createLazyFileRoute } from '@tanstack/react-router';
import { TenantsPage } from '../../../admin/TenantsPage.tsx';

export const Route = createLazyFileRoute('/admin/tenants/')({
  component: TenantsPage,
});
