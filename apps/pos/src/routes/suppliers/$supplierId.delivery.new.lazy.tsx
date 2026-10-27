import { createLazyFileRoute } from '@tanstack/react-router';
import { PermissionGate } from '../../components/PermissionGate.tsx';
import { AreaStrings } from '../../i18n/areas.tsx';
import { DeliveryPage } from '../../suppliers/DeliveryPage.tsx';

export const Route = createLazyFileRoute('/suppliers/$supplierId/delivery/new')(
  {
    component: DeliveryRoute,
  },
);

function DeliveryRoute() {
  const { supplierId } = Route.useParams();
  return (
    <AreaStrings area="office">
      <PermissionGate permission="purchase.create">
        <DeliveryPage supplierId={supplierId} />
      </PermissionGate>
    </AreaStrings>
  );
}
