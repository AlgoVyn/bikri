import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export const Route = createFileRoute('/udhaar')({
  validateSearch: (search: Record<string, unknown>): { customer?: string } => ({
    customer: typeof search.customer === 'string' ? search.customer : undefined,
  }),
  component: UdhaarPage,
});

function UdhaarPage() {
  return <ComingSoon titleKey="nav.udhaar" home />;
}
