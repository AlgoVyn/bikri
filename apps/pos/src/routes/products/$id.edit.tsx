import { createFileRoute } from '@tanstack/react-router';
import { ProductFormPage } from '../../products/ProductForm.tsx';

export const Route = createFileRoute('/products/$id/edit')({
  component: Edit,
});

function Edit() {
  const { id } = Route.useParams();
  return <ProductFormPage key={id} editId={id} />;
}
