import { createFileRoute } from '@tanstack/react-router';
import { ProductDetailPage } from '../../products/ProductDetail.tsx';

export const Route = createFileRoute('/products/$id/')({
  component: Detail,
});

function Detail() {
  const { id } = Route.useParams();
  return <ProductDetailPage id={id} />;
}
