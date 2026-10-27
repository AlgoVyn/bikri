import { createLazyFileRoute } from '@tanstack/react-router';
import { NewShopPage } from '../../../admin/NewShopPage.tsx';

export const Route = createLazyFileRoute('/admin/tenants/new')({
  component: NewShopPage,
});
