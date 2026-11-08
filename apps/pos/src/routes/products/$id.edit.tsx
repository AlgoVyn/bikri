import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../../components/PageLoading.tsx';

const ProductFormPage = lazy(() =>
  import('../../products/ProductForm.tsx').then((module) => ({
    default: module.ProductFormPage,
  })),
);

export const Route = createFileRoute('/products/$id/edit')({
  component: Edit,
});

function Edit() {
  const { id } = Route.useParams();
  return (
    <Suspense fallback={<PageLoading compact />}>
      <ProductFormPage key={id} editId={id} />
    </Suspense>
  );
}
