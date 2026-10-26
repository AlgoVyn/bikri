import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export const Route = createFileRoute('/sell')({
  component: SellPage,
});

function SellPage() {
  return <ComingSoon titleKey="nav.sell" home />;
}
