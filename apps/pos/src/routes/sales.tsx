import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export const Route = createFileRoute('/sales')({
  component: SalesPage,
});

function SalesPage() {
  return <ComingSoon titleKey="nav.sales" home />;
}
