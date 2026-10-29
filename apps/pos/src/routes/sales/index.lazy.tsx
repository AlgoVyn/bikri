import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { SalesWorkspace } from '../../sales/SalesWorkspace.tsx';

export const Route = createLazyFileRoute('/sales/')({
  component: SalesRoute,
});

function SalesRoute() {
  const { bill } = Route.useSearch();
  return (
    <AreaStrings area="office">
      <SalesWorkspace key={bill ?? 'list'} />
    </AreaStrings>
  );
}
