import { createFileRoute } from '@tanstack/react-router';
import { ProductList } from '../../products/ProductList.tsx';

export const Route = createFileRoute('/products/')({
  component: ProductList,
});
