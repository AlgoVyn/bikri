import { createFileRoute } from '@tanstack/react-router';
import { PricesPage } from '../../products/PricesPage.tsx';

export const Route = createFileRoute('/products/prices')({
  component: PricesPage,
});
