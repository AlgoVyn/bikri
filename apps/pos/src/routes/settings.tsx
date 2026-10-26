import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  return <ComingSoon titleKey="nav.settings" home />;
}
