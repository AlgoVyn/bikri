import { createLazyFileRoute } from '@tanstack/react-router';
import { TenantPage } from '../../../admin/TenantPage.tsx';

export const Route = createLazyFileRoute('/admin/tenants/$id')({
  component: function TenantRoute() {
    const { id } = Route.useParams();
    return <TenantPage key={id} id={id} />;
  },
});
