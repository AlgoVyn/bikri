import { createFileRoute, redirect } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

const DevKit = import.meta.env.DEV
  ? lazy(() => import('../dev/UiKitPage.tsx'))
  : null;

export const Route = createFileRoute('/dev/ui')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: '/' });
    }
  },
  component: DevUiPage,
});

function DevUiPage() {
  if (DevKit === null) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <DevKit />
    </Suspense>
  );
}
