import { createFileRoute } from '@tanstack/react-router';
import { ProductWorkspace } from '../../products/ProductWorkspace.tsx';

export const Route = createFileRoute('/products/$id/')({
  component: ProductRoute,
});

function ProductRoute() {
  const { id } = Route.useParams();
  return <ProductWorkspace id={id} />;
}
