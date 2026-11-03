import { createLazyFileRoute } from '@tanstack/react-router';
import { RequestShopPage } from '../public/RequestShopPage.tsx';

export const Route = createLazyFileRoute('/request')({
  component: RequestShopPage,
});
