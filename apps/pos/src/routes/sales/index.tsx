import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/sales/')({
  validateSearch: (search: Record<string, unknown>): { bill?: string } => ({
    bill: typeof search.bill === 'string' ? search.bill : undefined,
  }),
});
