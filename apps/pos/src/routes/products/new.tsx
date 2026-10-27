import { createFileRoute } from '@tanstack/react-router';
import { ProductFormPage } from '../../products/ProductForm.tsx';

export const Route = createFileRoute('/products/new')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { duplicate?: string } => ({
    duplicate:
      typeof search.duplicate === 'string' ? search.duplicate : undefined,
  }),
  component: NewProduct,
});

function NewProduct() {
  const { duplicate } = Route.useSearch();
  return <ProductFormPage key={duplicate ?? 'new'} duplicateOf={duplicate} />;
}
