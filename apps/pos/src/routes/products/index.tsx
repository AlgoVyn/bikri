import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../../components/PageLoading.tsx';

const ProductWorkspace = lazy(() =>
  import('../../products/ProductWorkspace.tsx').then((module) => ({
    default: module.ProductWorkspace,
  })),
);

export const Route = createFileRoute('/products/')({
  component: ProductsRoute,
});

function ProductsRoute() {
  return (
    <Suspense fallback={<PageLoading compact />}>
      <ProductWorkspace />
    </Suspense>
  );
}
