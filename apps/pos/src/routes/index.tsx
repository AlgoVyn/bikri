import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { PageLoading } from '../components/PageLoading.tsx';

const HomePage = lazy(() =>
  import('../home/HomePage.tsx').then((module) => ({
    default: module.HomePage,
  })),
);

export const Route = createFileRoute('/')({
  component: HomeRoute,
});

function HomeRoute() {
  return (
    <Suspense fallback={<PageLoading compact />}>
      <HomePage />
    </Suspense>
  );
}
