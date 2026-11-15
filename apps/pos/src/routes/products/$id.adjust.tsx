import { createFileRoute, Navigate } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../../components/PageLoading.tsx';
import { useCurrentStaff } from '../../state/currentStaff.ts';
import { useReadOnly } from '../../state/readOnly.ts';

const ProductWorkspace = lazy(() =>
  import('../../products/ProductWorkspace.tsx').then((module) => ({
    default: module.ProductWorkspace,
  })),
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
    return <Navigate to="/products/$id" params={{ id }} replace />;
  return (
    <Suspense fallback={<PageLoading compact />}>
      <ProductWorkspace key={id} id={id} adjust />
    </Suspense>
  );
}
