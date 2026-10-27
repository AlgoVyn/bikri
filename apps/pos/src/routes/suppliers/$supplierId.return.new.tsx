import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/suppliers/$supplierId/return/new')({
  validateSearch: (search: Record<string, unknown>): { purchase?: string } =>
    typeof search.purchase === 'string' ? { purchase: search.purchase } : {},
});
