import { createLazyFileRoute } from '@tanstack/react-router';
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
      <DeliveryPage supplierId={supplierId} />
    </AreaStrings>
  );
}
