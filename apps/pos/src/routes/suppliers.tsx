import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export const Route = createFileRoute('/suppliers')({
  component: Page,
});

function Page() {
  return <ComingSoon titleKey="nav.suppliers" home />;
}
