import { createFileRoute } from '@tanstack/react-router';
import { peekSearch } from '../../peek/search.ts';

export const Route = createFileRoute('/quotations/')({
  validateSearch: (search: Record<string, unknown>) => ({
    quote: typeof search.quote === 'string' ? search.quote : undefined,
    ...peekSearch(search),
  }),
});
