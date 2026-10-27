import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export type ProductsSearch = {
  id?: string;
  new?: 1;
  import?: 1;
  suggested?: 1;
};

const flag = (v: unknown): 1 | undefined =>
  v === 1 || v === '1' ? 1 : undefined;

export const Route = createFileRoute('/products')({
  validateSearch: (search: Record<string, unknown>): ProductsSearch => ({
    id: typeof search.id === 'string' ? search.id : undefined,
    new: flag(search.new),
    import: flag(search.import),
    suggested: flag(search.suggested),
  }),
  component: ProductsPage,
});

function ProductsPage() {
  return <ComingSoon titleKey="nav.products" home />;
}
