import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../../components/PageLoading.tsx';

const ProductWorkspace = lazy(() =>
  import('../../products/ProductWorkspace.tsx').then((module) => ({
    default: module.ProductWorkspace,
  })),
);

export const Route = createFileRoute('/products/$id/')({
  component: ProductRoute,
});

function ProductRoute() {
  const { id } = Route.useParams();
  return (
    <Suspense fallback={<PageLoading compact />}>
      <ProductWorkspace id={id} />
    </Suspense>
  );
}
