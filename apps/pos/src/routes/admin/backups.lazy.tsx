import { createLazyFileRoute } from '@tanstack/react-router';
import { BackupsPage } from '../../admin/BackupsPage.tsx';

export const Route = createLazyFileRoute('/admin/backups')({
  component: BackupsPage,
});
