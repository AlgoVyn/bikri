import { createFileRoute } from '@tanstack/react-router';
import type { CustomerFilter } from '../../data/udhaar.ts';

const FILTERS: CustomerFilter[] = [
  'all',
  'owes',
  'over_limit',
  'in_credit',
  'promise_due',
];

export const Route = createFileRoute('/udhaar/')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { filter?: CustomerFilter } => ({
    filter:
      typeof search.filter === 'string' &&
      FILTERS.includes(search.filter as CustomerFilter)
        ? (search.filter as CustomerFilter)
        : undefined,
  }),
});
