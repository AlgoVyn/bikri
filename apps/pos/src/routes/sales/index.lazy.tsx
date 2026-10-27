import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { SalesList } from '../../sales/SalesList.tsx';

export const Route = createLazyFileRoute('/sales/')({
  component: SalesRoute,
});

function SalesRoute() {
  const { bill } = Route.useSearch();
  return (
    <AreaStrings area="office">
      <SalesList bill={bill} />
    </AreaStrings>
  );
}
