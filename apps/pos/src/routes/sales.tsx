import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export const Route = createFileRoute('/sales')({
  validateSearch: (search: Record<string, unknown>): { bill?: string } => ({
    bill: typeof search.bill === 'string' ? search.bill : undefined,
  }),
  component: SalesPage,
});

function SalesPage() {
  return <ComingSoon titleKey="nav.sales" home />;
}
