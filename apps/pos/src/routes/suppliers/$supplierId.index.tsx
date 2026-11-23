import { createFileRoute } from '@tanstack/react-router';
import { peekSearch } from '../../peek/search.ts';

export const Route = createFileRoute('/suppliers/$supplierId/')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { delivery?: string; peek?: string } => ({
    delivery: typeof search.delivery === 'string' ? search.delivery : undefined,
    ...peekSearch(search),
  }),
});
