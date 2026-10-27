import { createLazyFileRoute } from '@tanstack/react-router';
import { PermissionGate } from '../../components/PermissionGate.tsx';
import { AreaStrings } from '../../i18n/areas.tsx';
import { SupplierReturnPage } from '../../suppliers/SupplierReturnPage.tsx';

export const Route = createLazyFileRoute('/suppliers/$supplierId/return/new')({
  component: ReturnRoute,
});

function ReturnRoute() {
  const { supplierId } = Route.useParams();
  const { purchase } = Route.useSearch();
  return (
    <AreaStrings area="office">
      <PermissionGate permission="purchase.create">
        <SupplierReturnPage
          supplierId={supplierId}
          initialPurchaseId={purchase}
        />
      </PermissionGate>
    </AreaStrings>
  );
}
