import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../../components/PageLoading.tsx';

const CategoriesPage = lazy(() =>
  import('../../products/Categories.tsx').then((module) => ({
    default: module.CategoriesPage,
  })),
);

export const Route = createFileRoute('/products/categories')({
  component: CategoriesRoute,
});

function CategoriesRoute() {
  return (
    <Suspense fallback={<PageLoading compact />}>
      <CategoriesPage />
    </Suspense>
  );
}
