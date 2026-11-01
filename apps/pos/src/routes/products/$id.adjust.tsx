import { createFileRoute, Navigate } from '@tanstack/react-router';
import { ProductWorkspace } from '../../products/ProductWorkspace.tsx';
import { useCurrentStaff } from '../../state/currentStaff.ts';
import { useReadOnly } from '../../state/readOnly.ts';

export const Route = createFileRoute('/products/$id/adjust')({
  component: Adjust,
});

/** screens/09 AC 5: without `stock.adjust` (or in a read-only shop) the route goes back. */
function Adjust() {
  const { id } = Route.useParams();
  const { can } = useCurrentStaff();
  const readOnly = useReadOnly();
  if (!can('stock.adjust') || readOnly)
    return <Navigate to="/products/$id" params={{ id }} replace />;
  return <ProductWorkspace key={id} id={id} adjust />;
}
