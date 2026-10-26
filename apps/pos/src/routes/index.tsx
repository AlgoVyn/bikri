import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  return <ComingSoon titleKey="nav.home" />;
}
