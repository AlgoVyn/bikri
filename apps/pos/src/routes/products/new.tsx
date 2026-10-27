import { createFileRoute } from '@tanstack/react-router';
import { ProductFormPage } from '../../products/ProductForm.tsx';

export const Route = createFileRoute('/products/new')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { duplicate?: string; barcode?: string } => ({
    duplicate:
      typeof search.duplicate === 'string' ? search.duplicate : undefined,
    barcode: typeof search.barcode === 'string' ? search.barcode : undefined,
  }),
  component: NewProduct,
});

function NewProduct() {
  const { duplicate, barcode } = Route.useSearch();
  return (
    <ProductFormPage
      key={duplicate ?? barcode ?? 'new'}
      duplicateOf={duplicate}
      barcode={barcode}
    />
  );
}
