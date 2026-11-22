import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/suppliers/$supplierId/')({
  validateSearch: (search: Record<string, unknown>): { delivery?: string } => ({
    delivery: typeof search.delivery === 'string' ? search.delivery : undefined,
  }),
});
