import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { SupplierList } from '../../suppliers/SupplierList.tsx';

export const Route = createLazyFileRoute('/suppliers/')({
  component: SuppliersRoute,
});

function SuppliersRoute() {
  return (
    <AreaStrings area="office">
      <SupplierList />
    </AreaStrings>
  );
}
