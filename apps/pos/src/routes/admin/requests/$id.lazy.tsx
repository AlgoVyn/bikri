import { createLazyFileRoute } from '@tanstack/react-router';
import { RequestPage } from '../../../admin/RequestPage.tsx';

export const Route = createLazyFileRoute('/admin/requests/$id')({
  component: function RequestRoute() {
    const { id } = Route.useParams();
    return <RequestPage key={id} id={id} />;
  },
});
