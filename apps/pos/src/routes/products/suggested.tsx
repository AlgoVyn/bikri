import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../../components/PageLoading.tsx';

const SuggestedPage = lazy(() =>
  import('../../products/Suggested.tsx').then((module) => ({
    default: module.SuggestedPage,
  })),
);

export const Route = createFileRoute('/products/suggested')({
  component: SuggestedRoute,
});

function SuggestedRoute() {
  return (
    <Suspense fallback={<PageLoading compact />}>
      <SuggestedPage />
    </Suspense>
  );
}
