import { createFileRoute } from '@tanstack/react-router';
import { ComingSoon } from '../shell/ComingSoon.tsx';

export const Route = createFileRoute('/products')({
  component: ProductsPage,
});

function ProductsPage() {
  return <ComingSoon titleKey="nav.products" home />;
}
