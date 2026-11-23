import { createFileRoute } from '@tanstack/react-router';
import { peekSearch } from '../../peek/search.ts';

export const Route = createFileRoute('/sales/$id')({
  validateSearch: peekSearch,
});
