import { createFileRoute, Navigate } from '@tanstack/react-router';
import { ProductDetailPage } from '../../products/ProductDetail.tsx';
import { useCurrentStaff } from '../../state/currentStaff.ts';

export const Route = createFileRoute('/products/$id/adjust')({
  component: Adjust,
});

/** screens/09 AC 5: without `stock.adjust` the route goes back to the product. */
function Adjust() {
  const { id } = Route.useParams();
  const { can } = useCurrentStaff();
  if (!can('stock.adjust'))
    return <Navigate to="/products/$id" params={{ id }} replace />;
  return <ProductDetailPage key={id} id={id} adjust />;
}
