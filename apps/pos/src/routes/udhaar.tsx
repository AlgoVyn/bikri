import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export const Route = createFileRoute('/udhaar')({
  component: UdhaarPage,
});

function UdhaarPage() {
  return <ComingSoon titleKey="nav.udhaar" home />;
}
