import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { UdhaarList } from '../../udhaar/CustomerList.tsx';

export const Route = createLazyFileRoute('/udhaar/')({
  component: UdhaarRoute,
});

function UdhaarRoute() {
  const { filter } = Route.useSearch();
  return (
    <AreaStrings area="office">
      <UdhaarList initialFilter={filter ?? 'all'} />
    </AreaStrings>
  );
}
