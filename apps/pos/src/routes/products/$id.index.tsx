import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { peekSearch } from '../../peek/search.ts';

const ProductWorkspace = lazyRouteComponent(
  () => import('../../products/ProductWorkspace.tsx'),
  'ProductWorkspace',
);

export const Route = createFileRoute('/products/$id/')({
  validateSearch: peekSearch,
  component: ProductRoute,
});

function ProductRoute() {
  const { id } = Route.useParams();
  return <ProductWorkspace id={id} />;
}
