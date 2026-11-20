import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

const ProductWorkspace = lazyRouteComponent(
  () => import('../../products/ProductWorkspace.tsx'),
  'ProductWorkspace',
);

export const Route = createFileRoute('/products/$id/')({
  component: ProductRoute,
});

function ProductRoute() {
  const { id } = Route.useParams();
  return <ProductWorkspace id={id} />;
}
