import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { SupplierStatement } from '../../suppliers/SupplierStatement.tsx';

export const Route = createLazyFileRoute('/suppliers/$supplierId/')({
  component: SupplierRoute,
});

function SupplierRoute() {
  const { supplierId } = Route.useParams();
  return (
    <AreaStrings area="office">
      <SupplierStatement supplierId={supplierId} />
    </AreaStrings>
  );
}
