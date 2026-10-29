import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { SupplierWorkspace } from '../../suppliers/SupplierWorkspace.tsx';

export const Route = createLazyFileRoute('/suppliers/')({
  component: SuppliersRoute,
});

function SuppliersRoute() {
  return (
    <AreaStrings area="office">
      <SupplierWorkspace />
    </AreaStrings>
  );
}
