import { createLazyFileRoute, Outlet } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { SalesWorkspace } from '../../sales/SalesWorkspace.tsx';

export const Route = createLazyFileRoute('/sales/$id')({
  component: BillRoute,
});

function BillRoute() {
  const { id } = Route.useParams();
  return (
    <AreaStrings area="office">
      <SalesWorkspace saleId={id} />
      <Outlet />
    </AreaStrings>
  );
}
