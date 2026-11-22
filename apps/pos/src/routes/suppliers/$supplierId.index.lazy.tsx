import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { SupplierWorkspace } from '../../suppliers/SupplierWorkspace.tsx';

export const Route = createLazyFileRoute('/suppliers/$supplierId/')({
  component: SupplierRoute,
});

function SupplierRoute() {
  const { supplierId } = Route.useParams();
  const { delivery } = Route.useSearch();
  return (
    <AreaStrings area="office">
      <SupplierWorkspace supplierId={supplierId} delivery={delivery} />
    </AreaStrings>
  );
}
