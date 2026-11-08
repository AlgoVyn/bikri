import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../../components/PageLoading.tsx';

const ProductFormPage = lazy(() =>
  import('../../products/ProductForm.tsx').then((module) => ({
    default: module.ProductFormPage,
  })),
);

export const Route = createFileRoute('/products/new')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { duplicate?: string; barcode?: string } => ({
    duplicate:
      typeof search.duplicate === 'string' ? search.duplicate : undefined,
    barcode: typeof search.barcode === 'string' ? search.barcode : undefined,
  }),
  component: NewProduct,
});

function NewProduct() {
  const { duplicate, barcode } = Route.useSearch();
  return (
    <Suspense fallback={<PageLoading compact />}>
      <ProductFormPage
        key={duplicate ?? barcode ?? 'new'}
        duplicateOf={duplicate}
        barcode={barcode}
      />
    </Suspense>
  );
}
