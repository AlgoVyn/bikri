import {
  createFileRoute,
  lazyRouteComponent,
  Navigate,
} from '@tanstack/react-router';
import { useCurrentStaff } from '../../state/currentStaff.ts';
import { useReadOnly } from '../../state/readOnly.ts';

const ProductWorkspace = lazyRouteComponent(
  () => import('../../products/ProductWorkspace.tsx'),
  'ProductWorkspace',
);

export const Route = createFileRoute('/products/$id/adjust')({
  component: Adjust,
});

/** screens/09 AC 5: without `stock.adjust` (or in a read-only shop) the route goes back. */
function Adjust() {
  const { id } = Route.useParams();
  const { can } = useCurrentStaff();
  const readOnly = useReadOnly();
  if (!can('stock.adjust') || readOnly)
    return <Navigate to="/products/$id" params={{ id }} state={true} replace />;
  return <ProductWorkspace key={id} id={id} adjust />;
}
