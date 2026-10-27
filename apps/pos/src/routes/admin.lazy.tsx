import { createLazyFileRoute } from '@tanstack/react-router';
import { AdminShell } from '../admin/AdminShell.tsx';

export const Route = createLazyFileRoute('/admin')({
  component: AdminShell,
});
