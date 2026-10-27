import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/suppliers/$supplierId')({
  component: SupplierLayout,
});

function SupplierLayout() {
  return <Outlet />;
}
