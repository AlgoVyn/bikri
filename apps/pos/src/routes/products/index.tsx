import { createFileRoute } from '@tanstack/react-router';
import { ProductWorkspace } from '../../products/ProductWorkspace.tsx';

export const Route = createFileRoute('/products/')({
  component: ProductsRoute,
});

function ProductsRoute() {
  return <ProductWorkspace />;
}
