import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

const ProductFormPage = lazyRouteComponent(
  () => import('../../products/ProductForm.tsx'),
  'ProductFormPage',
);

export const Route = createFileRoute('/products/$id/edit')({
  component: Edit,
});

function Edit() {
  const { id } = Route.useParams();
  return <ProductFormPage key={id} editId={id} />;
}
