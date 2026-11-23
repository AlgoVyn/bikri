import { createFileRoute } from '@tanstack/react-router';
import { peekSearch } from '../../peek/search.ts';

export const Route = createFileRoute('/sales/')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { bill?: string; peek?: string } => ({
    bill: typeof search.bill === 'string' ? search.bill : undefined,
    ...peekSearch(search),
  }),
});
